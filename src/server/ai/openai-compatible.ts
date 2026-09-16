import { z } from "zod";
import { request as httpsRequest } from "node:https";
import { type AiConfig } from "@/server/config/env";
import { ApiError } from "@/server/http/api-error";
import { resolveSafeOutboundBaseUrl } from "@/server/security/outbound-url";

const AI_TIMEOUT_MS = 90_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

const providerResponseSchema = z.looseObject({
    id: z.string().optional(),
    choices: z
        .array(
            z.looseObject({
                message: z.looseObject({
                    // 推理型模型在 max_tokens 耗尽时 content 可能为 null
                    content: z.string().max(50_000).nullable().optional(),
                }),
            })
        )
        .min(1),
    usage: z
        .looseObject({
            prompt_tokens: z.number().int().nonnegative().optional(),
            completion_tokens: z.number().int().nonnegative().optional(),
        })
        .optional(),
});

export interface AiInterpretationResult {
    interpretation: string;
    provider: string;
    model: string;
    providerRequestId?: string;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs: number;
}

// 提取 OpenAI 兼容错误响应中的 message，便于定位服务商侧问题
function extractProviderErrorMessage(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return null;
    const message = (payload as { error?: { message?: unknown } }).error
        ?.message;
    if (typeof message !== "string" || !message.trim()) return null;
    return message.trim().slice(0, 200);
}

async function requestCustomProvider(options: {
    config: AiConfig;
    systemPrompt: string;
    userPrompt: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
}): Promise<{ status: number; payload: unknown }> {
    const target = await resolveSafeOutboundBaseUrl(options.config.baseUrl);
    const requestUrl = new URL("chat/completions", `${target.url.toString().replace(/\/+$/, "")}/`);
    const requestBody = JSON.stringify({
        model: options.config.model,
        messages: [
            { role: "system", content: options.systemPrompt },
            { role: "user", content: options.userPrompt },
        ],
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        stream: false,
    });

    return new Promise((resolve, reject) => {
        let timedOut = false;
        const request = httpsRequest(requestUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(requestBody),
                Authorization: `Bearer ${options.config.apiKey}`,
            },
            servername: requestUrl.hostname,
            lookup: (_hostname, lookupOptions, callback) => {
                const address = { address: target.address, family: target.family };
                if (lookupOptions.all) {
                    callback(null, [address]);
                    return;
                }
                callback(null, address.address, address.family);
            },
        }, (response) => {
            const chunks: Buffer[] = [];
            let receivedBytes = 0;

            response.on("data", (chunk: Buffer) => {
                receivedBytes += chunk.length;
                if (receivedBytes > MAX_PROVIDER_RESPONSE_BYTES) {
                    request.destroy(new Error("AI_RESPONSE_TOO_LARGE"));
                    return;
                }
                chunks.push(chunk);
            });
            response.on("end", () => {
                const responseText = Buffer.concat(chunks).toString("utf8");
                let payload: unknown;
                try {
                    payload = JSON.parse(responseText);
                } catch {
                    reject(new ApiError(502, "AI_INVALID_RESPONSE", "AI 服务返回格式无效"));
                    return;
                }
                resolve({ status: response.statusCode || 502, payload });
            });
        });

        request.setTimeout(options.timeoutMs, () => {
            timedOut = true;
            request.destroy();
        });
        request.on("error", (error) => {
            if (timedOut) {
                reject(new ApiError(504, "AI_TIMEOUT", "AI 解读超时，请稍后重试"));
                return;
            }
            if (error.message === "AI_RESPONSE_TOO_LARGE") {
                reject(new ApiError(502, "AI_INVALID_RESPONSE", "AI 服务返回内容过大"));
                return;
            }
            reject(new ApiError(502, "AI_NETWORK_ERROR", "无法连接 AI 服务"));
        });
        request.write(requestBody);
        request.end();
    });
}

export async function requestAiInterpretation(options: {
    systemPrompt: string;
    userPrompt: string;
    config: AiConfig;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
}): Promise<AiInterpretationResult> {
    const config = options.config;
    const temperature = options.temperature ?? 0.7;
    const maxTokens = options.maxTokens ?? 1800;
    const timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;
    const startedAt = Date.now();

    const { status: responseStatus, payload } = await requestCustomProvider({
        config,
        systemPrompt: options.systemPrompt,
        userPrompt: options.userPrompt,
        temperature,
        maxTokens,
        timeoutMs,
    });

    if (responseStatus < 200 || responseStatus >= 300) {
        const detail = extractProviderErrorMessage(payload);
        throw new ApiError(
            502,
            "AI_PROVIDER_ERROR",
            `AI 服务返回错误（状态码 ${responseStatus}）${detail ? `：${detail}` : ""}`
        );
    }

    const parsed = providerResponseSchema.safeParse(payload);
    if (!parsed.success) {
        throw new ApiError(502, "AI_INVALID_RESPONSE", "AI 服务返回内容无效");
    }

    const interpretation = parsed.data.choices[0].message.content?.trim();
    if (!interpretation) {
        throw new ApiError(
            502,
            "AI_EMPTY_RESPONSE",
            "AI 返回内容为空（推理型模型可能因生成长度不足，token 全部用于思考）"
        );
    }

    return {
        interpretation,
        provider: new URL(config.baseUrl).host,
        model: config.model,
        providerRequestId: parsed.data.id,
        inputTokens: parsed.data.usage?.prompt_tokens,
        outputTokens: parsed.data.usage?.completion_tokens,
        latencyMs: Date.now() - startedAt,
    };
}
