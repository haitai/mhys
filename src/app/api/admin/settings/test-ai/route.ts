import { aiConnectionTestSchema } from "@/features/settings/contracts";
import { requireAdminSession } from "@/server/auth/admin-request";
import { requestAiInterpretation } from "@/server/ai/openai-compatible";
import { assertSameOrigin } from "@/server/http/origin";
import { parseJsonBody } from "@/server/http/request";
import { apiFailure, apiSuccess, getRequestId } from "@/server/http/response";
import { logInfo } from "@/server/observability/logger";
import { resolveAiConfigDraft } from "@/server/settings/runtime-settings";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
    const requestId = getRequestId(request);
    try {
        assertSameOrigin(request);
        await requireAdminSession();
        const draft = await parseJsonBody(
            request,
            aiConnectionTestSchema,
            8 * 1024
        );
        const config = await resolveAiConfigDraft(draft);
        const result = await requestAiInterpretation({
            systemPrompt: "你正在执行 AI 服务连接检测。",
            userPrompt: "只回复四个字：连接成功",
            config,
            temperature: 0,
            // 推理型模型会把部分 token 用于思考，16 容易导致正文为空
            maxTokens: 512,
            timeoutMs: 25_000,
        });
        logInfo("admin_ai_connection_tested", {
            requestId,
            provider: result.provider,
            model: result.model,
            latencyMs: result.latencyMs,
        });

        return apiSuccess(
            {
                provider: result.provider,
                model: result.model,
                latencyMs: result.latencyMs,
            },
            requestId
        );
    } catch (error) {
        return apiFailure(error, requestId, {
            route: "/api/admin/settings/test-ai",
        });
    }
}
