import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isApiError } from "@/server/http/api-error";
import { logError } from "@/server/observability/logger";

export function getRequestId(request: Request): string {
    return request.headers.get("x-vercel-id") || randomUUID();
}

export function apiSuccess<T>(data: T, requestId: string, status = 200) {
    return NextResponse.json(
        { ok: true, data, requestId },
        {
            status,
            headers: { "x-request-id": requestId },
        }
    );
}

export function apiFailure(
    error: unknown,
    requestId: string,
    context: Record<string, unknown> = {}
) {
    if (isApiError(error)) {
        const headers = new Headers({ "x-request-id": requestId });
        if (error.retryAfterSeconds) {
            headers.set("Retry-After", String(error.retryAfterSeconds));
        }

        // 前置 CDN 会拦截源站 5xx 并替换响应体，应用级错误统一返回 200，
        // 错误语义由 envelope 的 ok/error 字段承载。
        const status = error.status >= 500 ? 200 : error.status;

        return NextResponse.json(
            {
                ok: false,
                error: { code: error.code, message: error.message },
                requestId,
            },
            { status, headers }
        );
    }

    logError("api_unhandled_error", error, { requestId, ...context });
    return NextResponse.json(
        {
            ok: false,
            error: { code: "INTERNAL_ERROR", message: "服务器内部错误" },
            requestId,
        },
        {
            status: 200,
            headers: { "x-request-id": requestId },
        }
    );
}
