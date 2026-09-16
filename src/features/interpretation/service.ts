import { calculateHexagrams } from "@/lib/meihua";
import {
    toPersistedInterpretationRequest,
    type InterpretationRequest,
} from "@/features/interpretation/contracts";
import {
    buildInterpretationSystemPrompt,
    buildInterpretationUserPrompt,
    INTERPRETATION_PROMPT_VERSION,
} from "@/features/interpretation/prompt";
import { requestAiInterpretation } from "@/server/ai/openai-compatible";
import {
    completeInterpretationRecord,
    createOrReusePendingRecord,
    failInterpretationRecord,
} from "@/server/db/divination-repository";
import {
    getAnonymousSessionSecret,
} from "@/server/config/env";
import { ApiError, isApiError } from "@/server/http/api-error";
import { logInfo, logWarn } from "@/server/observability/logger";
import {
    enforceRateLimit,
    getRequestIp,
    hashRateLimitKey,
} from "@/server/security/rate-limit";
import {
    getEffectiveAiConfig,
    getRuntimeSettings,
} from "@/server/settings/runtime-settings";
import type { UsageLimitSettings } from "@/features/settings/contracts";

async function enforceAiLimits(
    request: Request,
    userId: string,
    limits: UsageLimitSettings
): Promise<void> {
    const secret = getAnonymousSessionSecret();
    const ip = getRequestIp(request);

    const userHash = hashRateLimitKey("ai-user", userId, secret);
    const ipHash = hashRateLimitKey("ai-ip", ip, secret);
    const globalHash = hashRateLimitKey("ai-global", "all", secret);

    await enforceRateLimit({
        scope: "ai_user_10m",
        keyHash: userHash,
        limit: limits.userPerTenMinutes,
        windowSeconds: 10 * 60,
    });
    await enforceRateLimit({
        scope: "ai_user_daily",
        keyHash: userHash,
        limit: limits.userDaily,
        windowSeconds: 24 * 60 * 60,
        message: limits.limitMessage,
    });
    await enforceRateLimit({
        scope: "ai_ip_10m",
        keyHash: ipHash,
        limit: limits.ipPerTenMinutes,
        windowSeconds: 10 * 60,
    });
    await enforceRateLimit({
        scope: "ai_global_daily",
        keyHash: globalHash,
        limit: limits.globalDaily,
        windowSeconds: 24 * 60 * 60,
        message: limits.limitMessage,
    });
}

export async function interpretDivination(options: {
    request: Request;
    requestId: string;
    userId: string;
    input: InterpretationRequest;
}) {
    const { request, requestId, userId, input } = options;
    const settings = await getRuntimeSettings();

    if (!settings.divination.aiInterpretationEnabled) {
        throw new ApiError(503, "AI_DISABLED", "本站暂未开放 AI 解卦");
    }
    if (!settings.divination.enabledMethods.includes(input.method)) {
        throw new ApiError(400, "METHOD_DISABLED", "当前起卦方式已停用");
    }
    if (input.question.length > settings.divination.maxQuestionLength) {
        throw new ApiError(
            400,
            "QUESTION_TOO_LONG",
            `问题不能超过 ${settings.divination.maxQuestionLength} 个字符`
        );
    }
    if (input.aiConfig && !settings.divination.allowCustomAi) {
        throw new ApiError(
            403,
            "CUSTOM_AI_DISABLED",
            "本站暂不允许使用自定义 AI 服务"
        );
    }

    await enforceAiLimits(request, userId, settings.limits);

    const result = calculateHexagrams(
        input.numbers.num1,
        input.numbers.num2,
        input.numbers.num3,
        input.numbers.movingLine,
        input.method,
        new Date(input.timeContext.occurredAt)
    );
    const customAiConfig = input.aiConfig;
    const resolvedAi = customAiConfig ? null : await getEffectiveAiConfig();
    const aiConfig = customAiConfig || resolvedAi!.config;
    const persistedInput = toPersistedInterpretationRequest(input);

    const pending = await createOrReusePendingRecord({
        userId,
        input: persistedInput,
        result,
        provider: customAiConfig ? null : new URL(aiConfig.baseUrl).host,
        model: customAiConfig ? null : aiConfig.model,
    });

    if (pending.state === "completed") {
        logInfo("ai_idempotent_hit", { requestId, recordId: pending.record.id });
        return {
            recordId: pending.record.id,
            result: pending.record.result,
            interpretation: pending.record.interpretation!,
            cached: true,
        };
    }

    if (pending.state === "pending") {
        throw new ApiError(409, "REQUEST_IN_PROGRESS", "该解读正在处理中");
    }

    const userPrompt = buildInterpretationUserPrompt(input, result);
    const systemPrompt = buildInterpretationSystemPrompt(
        settings.interpretation
    );
    logInfo("ai_request_started", {
        requestId,
        recordId: pending.record.id,
        method: input.method,
        questionLength: input.question.length,
        promptVersion: INTERPRETATION_PROMPT_VERSION,
    });

    try {
        // 统一走 requestCustomProvider（node:https）：Vercel 上全局 fetch 出站会导致函数被平台层重置。
        const aiResult = await requestAiInterpretation({
            systemPrompt,
            userPrompt,
            config: aiConfig,
        });

        const record = await completeInterpretationRecord({
            recordId: pending.record.id,
            userId,
            interpretation: aiResult.interpretation,
            provider: customAiConfig ? null : aiResult.provider,
            model: customAiConfig ? null : aiResult.model,
            latencyMs: aiResult.latencyMs,
            inputTokens: aiResult.inputTokens,
            outputTokens: aiResult.outputTokens,
        });

        logInfo("ai_request_completed", {
            requestId,
            recordId: record.id,
            latencyMs: aiResult.latencyMs,
            inputTokens: aiResult.inputTokens,
            outputTokens: aiResult.outputTokens,
        });

        return {
            recordId: record.id,
            result,
            interpretation: aiResult.interpretation,
            cached: false,
        };
    } catch (error) {
        const errorCode = isApiError(error) ? error.code : "AI_INTERNAL_ERROR";
        await failInterpretationRecord({
            recordId: pending.record.id,
            userId,
            errorCode,
        }).catch(() => undefined);

        logWarn("ai_request_failed", {
            requestId,
            recordId: pending.record.id,
            errorCode,
        });
        throw error;
    }
}
