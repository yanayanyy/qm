import {
  DEFAULT_AGENT_MODEL_ID,
  isModelProvider,
  providerBaseUrl,
  wireModelId,
  type ModelProvider,
} from "../../../model/pi-models.ts";
import { selectableModelCatalog } from "../../../model/model-catalog.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

const VALIDATION_REQUESTS: Record<
  ModelProvider,
  { baseUrl: string; path: string; headers: (apiKey: string) => Record<string, string> }
> = {
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    path: "/v1/models",
    headers: (apiKey) => ({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" }),
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    path: "/models",
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    path: "/key",
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  },
};

function validationUrl(provider: ModelProvider): string {
  const request = VALIDATION_REQUESTS[provider];
  return `${providerBaseUrl(provider) ?? request.baseUrl}${request.path}`;
}

async function actor(ctx: ApiCtx) {
  const scope = orgScope(ctx.deps);
  return authorizeAdmin(ctx, scope);
}

async function anthropicGatewayProbe(fetchImpl: typeof fetch, apiKey: string, baseUrl: string): Promise<boolean> {
  try {
    const response = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        ...VALIDATION_REQUESTS.anthropic.headers(apiKey),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: wireModelId(DEFAULT_AGENT_MODEL_ID),
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function validate(ctx: ApiCtx, provider: ModelProvider, apiKey: string): Promise<boolean> {
  const fetchImpl = ctx.deps.modelCredentialFetch ?? fetch;
  try {
    const response = await fetchImpl(validationUrl(provider), {
      headers: VALIDATION_REQUESTS[provider].headers(apiKey),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) return true;
    const gateway = providerBaseUrl(provider);
    if ((response.status === 404 || response.status === 405) && gateway && provider === "anthropic") {
      return anthropicGatewayProbe(fetchImpl, apiKey, gateway);
    }
    return false;
  } catch {
    return false;
  }
}

export async function getModelProviders(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.modelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "model-providers.read",
    resource: "model-providers",
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, {
    providers: await ctx.deps.modelCredentials.statuses(),
    models: await selectableModelCatalog(ctx.deps.modelCredentialFetch),
  });
}

export async function putModelProvider(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.modelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  const provider = ctx.params.provider;
  if (!isModelProvider(provider)) return sendJson(ctx.res, 404, { error: "not_found" });
  const apiKey = (ctx.body as { apiKey?: unknown }).apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "API key is required" });
  }
  if (!(await validate(ctx, provider, apiKey.trim()))) {
    return sendJson(ctx.res, 400, { error: "invalid_api_key", message: `${provider} rejected this API key` });
  }
  await ctx.deps.modelCredentials.set(provider, apiKey.trim(), authorized.id);
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "model-providers.update",
    resource: provider,
    scopeLabel: orgScope(ctx.deps),
  });
  const status = (await ctx.deps.modelCredentials.statuses()).find((item) => item.provider === provider);
  return sendJson(ctx.res, 200, { ok: true, status });
}

export async function deleteModelProvider(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.modelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  const provider = ctx.params.provider;
  if (!isModelProvider(provider)) return sendJson(ctx.res, 404, { error: "not_found" });
  await ctx.deps.modelCredentials.delete(provider, authorized.id);
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "model-providers.delete",
    resource: provider,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
}
