import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type {
  OAuthDiscoveryState,
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { DEFAULT_FIGMA_OAUTH_TIMEOUT_MS, DEFAULT_RESOURCE_TIMEOUT_MS } from "../config/defaults.js";
import { ensureDirectory } from "../io/fs.js";
import { bufferToNormalizedPng } from "../io/image.js";
import type { ParsedReferenceInput, PreparedReferenceImage } from "../types/internal.js";
import type { ReferenceTransport } from "../types/report.js";
import { AppError, ensureError } from "../utils/errors.js";
import type { ReferenceProvider } from "./provider.js";

const PEYE_CLIENT_NAME = "peye";
const PEYE_CLIENT_VERSION = "0.1.0";
const SCREENSHOT_TOOL_NAME = "get_screenshot";
const METADATA_TOOL_NAME = "get_metadata";
const MAX_ACCEPTABLE_ASPECT_RATIO_DELTA = 0.02;

interface FigmaMcpReferenceProviderOptions {
  readonly serverUrl: string;
  readonly transport: Extract<ReferenceTransport, "figma-mcp-desktop" | "figma-mcp-remote">;
}

interface OAuthStateFile {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

interface Deferred<TValue> {
  promise: Promise<TValue>;
  reject: (error: unknown) => void;
  resolve: (value: TValue) => void;
}

interface OAuthCallbackServer {
  readonly redirectUrl: string;
  waitForAuthorizationCode(): Promise<string>;
  close(): Promise<void>;
}

export class FigmaMcpReferenceProvider implements ReferenceProvider {
  readonly kind = "figma-url" as const;
  private readonly serverUrl: string;
  private readonly transport: FigmaMcpReferenceProviderOptions["transport"];

  constructor(options: FigmaMcpReferenceProviderOptions) {
    this.serverUrl = options.serverUrl;
    this.transport = options.transport;
  }

  async prepare(
    reference: ParsedReferenceInput,
    outputPath: string,
  ): Promise<PreparedReferenceImage> {
    if (reference.kind !== "figma-url") {
      throw new AppError(
        `Unsupported reference input kind for Figma MCP provider: ${reference.kind}`,
        {
          code: "reference_provider_kind_mismatch",
        },
      );
    }

    const callbackServer =
      this.transport === "figma-mcp-remote" && isInteractiveTerminal()
        ? await createOAuthCallbackServer()
        : null;
    const oauthProvider =
      this.transport === "figma-mcp-remote" && callbackServer
        ? await PersistentOAuthClientProvider.create(this.serverUrl, callbackServer)
        : null;
    const transportOptions =
      oauthProvider === null
        ? { fetch: fetchWithTimeout }
        : { authProvider: oauthProvider, fetch: fetchWithTimeout };
    const transport = new StreamableHTTPClientTransport(new URL(this.serverUrl), transportOptions);
    const client = new Client(
      {
        name: PEYE_CLIENT_NAME,
        version: PEYE_CLIENT_VERSION,
      },
      {
        capabilities: {},
      },
    );

    try {
      await runWithOAuthRetry(transport, oauthProvider, callbackServer, () =>
        client.connect(transport as Transport),
      );

      const tools = await runWithOAuthRetry(transport, oauthProvider, callbackServer, () =>
        client.listTools(),
      );
      const hasScreenshotTool = tools.tools.some((tool) => tool.name === SCREENSHOT_TOOL_NAME);

      if (!hasScreenshotTool) {
        throw new AppError(
          `Figma MCP server at ${this.serverUrl} does not expose ${SCREENSHOT_TOOL_NAME}.`,
          {
            code: "figma_mcp_tool_missing",
          },
        );
      }

      const result = await runWithOAuthRetry(transport, oauthProvider, callbackServer, () =>
        client.callTool({
          name: SCREENSHOT_TOOL_NAME,
          arguments: {
            fileKey: reference.fileKey,
            nodeId: reference.nodeId,
          },
        }),
      );
      const buffer = extractImageBuffer(result, this.serverUrl);
      const resizeTarget = tools.tools.some((tool) => tool.name === METADATA_TOOL_NAME)
        ? await resolveMetadataResizeTarget(
            client,
            transport,
            oauthProvider,
            callbackServer,
            reference,
            buffer,
          )
        : null;
      const prepared =
        resizeTarget === null
          ? await bufferToNormalizedPng(buffer, outputPath)
          : await bufferToNormalizedPng(buffer, outputPath, {
              resizeTo: resizeTarget,
            });

      return {
        ...prepared,
        transport: this.transport,
      };
    } catch (error) {
      throw mapMcpError(error, this.transport, this.serverUrl);
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      await callbackServer?.close().catch(() => undefined);
    }
  }
}

async function resolveMetadataResizeTarget(
  client: Client,
  transport: StreamableHTTPClientTransport,
  oauthProvider: PersistentOAuthClientProvider | null,
  callbackServer: OAuthCallbackServer | null,
  reference: Extract<ParsedReferenceInput, { kind: "figma-url" }>,
  screenshotBuffer: Buffer,
): Promise<{ width: number; height: number } | null> {
  const metadataResult = await runWithOAuthRetry(transport, oauthProvider, callbackServer, () =>
    client.callTool({
      name: METADATA_TOOL_NAME,
      arguments: {
        fileKey: reference.fileKey,
        nodeId: reference.nodeId,
      },
    }),
  );

  const targetDimensions = extractNodeDimensions(metadataResult);

  if (targetDimensions === null) {
    return null;
  }

  const currentDimensions = await readBufferDimensions(screenshotBuffer);

  if (
    currentDimensions.width >= targetDimensions.width ||
    currentDimensions.height >= targetDimensions.height
  ) {
    return null;
  }

  const currentAspectRatio = currentDimensions.width / currentDimensions.height;
  const targetAspectRatio = targetDimensions.width / targetDimensions.height;

  if (Math.abs(currentAspectRatio - targetAspectRatio) > MAX_ACCEPTABLE_ASPECT_RATIO_DELTA) {
    return null;
  }

  return targetDimensions;
}

async function runWithOAuthRetry<TValue>(
  transport: StreamableHTTPClientTransport,
  provider: PersistentOAuthClientProvider | null,
  callbackServer: OAuthCallbackServer | null,
  operation: () => Promise<TValue>,
): Promise<TValue> {
  let hasRetried = false;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || provider === null || callbackServer === null) {
        throw error;
      }

      if (hasRetried) {
        throw error;
      }

      hasRetried = true;
      const authorizationCode = await callbackServer.waitForAuthorizationCode();
      await transport.finishAuth(authorizationCode);
    }
  }
}

function extractImageBuffer(
  result: Awaited<ReturnType<Client["callTool"]>>,
  serverUrl: string,
): Buffer {
  if ("toolResult" in result) {
    throw new AppError(`Figma MCP server at ${serverUrl} returned an unsupported tool result.`, {
      exitCode: 3,
      recommendation: "needs_human_review",
      severity: "high",
      code: "figma_mcp_invalid_response",
    });
  }

  if (result.isError) {
    const message = extractTextContent(result.content) ?? "Figma MCP tool returned an error.";
    throw new AppError(message, {
      exitCode: 3,
      recommendation: "needs_human_review",
      severity: "high",
      code: "figma_mcp_invalid_response",
    });
  }

  for (const block of result.content) {
    if (block.type === "image" && block.mimeType.startsWith("image/")) {
      return Buffer.from(block.data, "base64");
    }

    if (block.type === "resource" && "blob" in block.resource) {
      const mimeType = block.resource.mimeType ?? "";

      if (mimeType.startsWith("image/")) {
        return Buffer.from(block.resource.blob, "base64");
      }
    }
  }

  throw new AppError(
    `Figma MCP server at ${serverUrl} returned no image content for get_screenshot.`,
    {
      exitCode: 3,
      recommendation: "needs_human_review",
      severity: "high",
      code: "figma_mcp_invalid_response",
    },
  );
}

function extractNodeDimensions(
  result: Awaited<ReturnType<Client["callTool"]>>,
): { width: number; height: number } | null {
  if ("toolResult" in result || result.isError) {
    return null;
  }

  const metadataText = extractTextContent(result.content);

  if (!metadataText) {
    return null;
  }

  const rootTagMatch = metadataText.match(/<[^>]+>/);

  if (!rootTagMatch) {
    return null;
  }

  const widthMatch = rootTagMatch[0].match(/\bwidth="([^"]+)"/);
  const heightMatch = rootTagMatch[0].match(/\bheight="([^"]+)"/);
  const width = Math.round(Number.parseFloat(widthMatch?.[1] ?? ""));
  const height = Math.round(Number.parseFloat(heightMatch?.[1] ?? ""));

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

function extractTextContent(
  content: ReadonlyArray<{ type: string; text?: string }>,
): string | null {
  for (const block of content) {
    if (block.type === "text") {
      return block.text ?? null;
    }
  }

  return null;
}

async function readBufferDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
  const metadata = await sharp(buffer).metadata();

  if (!metadata.width || !metadata.height) {
    throw new AppError("Could not read dimensions from the Figma MCP screenshot buffer.", {
      code: "figma_mcp_invalid_response",
    });
  }

  return {
    width: metadata.width,
    height: metadata.height,
  };
}

function mapMcpError(error: unknown, transport: ReferenceTransport, serverUrl: string): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof UnauthorizedError) {
    return new AppError(
      transport === "figma-mcp-remote"
        ? "Remote Figma MCP requires OAuth authorization."
        : `Figma MCP at ${serverUrl} rejected the request as unauthorized.`,
      {
        code: "figma_mcp_auth_required",
        cause: error,
      },
    );
  }

  if (error instanceof StreamableHTTPError && error.code === 401) {
    return new AppError(
      transport === "figma-mcp-remote"
        ? "Remote Figma MCP requires OAuth authorization."
        : `Figma MCP at ${serverUrl} rejected the request as unauthorized.`,
      {
        code: "figma_mcp_auth_required",
        cause: error,
      },
    );
  }

  return new AppError(
    `Failed to read Figma reference through ${transport} at ${serverUrl}. ${ensureError(error).message}`,
    {
      code: "figma_mcp_request_failed",
      cause: error,
    },
  );
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(DEFAULT_RESOURCE_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return fetch(input, {
    ...init,
    signal,
  });
}

class PersistentOAuthClientProvider implements OAuthClientProvider {
  private readonly callbackServer: OAuthCallbackServer;
  private readonly storagePath: string;
  private readonly oauthState: OAuthStateFile;

  private constructor(
    callbackServer: OAuthCallbackServer,
    storagePath: string,
    state: OAuthStateFile,
  ) {
    this.callbackServer = callbackServer;
    this.storagePath = storagePath;
    this.oauthState = state;
  }

  static async create(
    serverUrl: string,
    callbackServer: OAuthCallbackServer,
  ): Promise<PersistentOAuthClientProvider> {
    const storagePath = await oauthStatePath(serverUrl);
    const state = await loadOAuthState(storagePath);
    return new PersistentOAuthClientProvider(callbackServer, storagePath, state);
  }

  get redirectUrl(): string {
    return this.callbackServer.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "peye",
      redirect_uris: [this.callbackServer.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.oauthState.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.oauthState.clientInformation = clientInformation;
    await this.persist();
  }

  tokens(): OAuthTokens | undefined {
    return this.oauthState.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.oauthState.tokens = tokens;
    await this.persist();
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    process.stderr.write(
      [
        "Remote Figma MCP requires authorization.",
        `Open this URL to continue: ${authorizationUrl.toString()}`,
      ].join("\n") + "\n",
    );
    openExternalUrl(authorizationUrl.toString());
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.oauthState.codeVerifier = codeVerifier;
    await this.persist();
  }

  codeVerifier(): string {
    if (!this.oauthState.codeVerifier) {
      throw new Error("No OAuth code verifier available.");
    }

    return this.oauthState.codeVerifier;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all" || scope === "client") {
      delete this.oauthState.clientInformation;
    }

    if (scope === "all" || scope === "tokens") {
      delete this.oauthState.tokens;
    }

    if (scope === "all" || scope === "verifier") {
      delete this.oauthState.codeVerifier;
    }

    if (scope === "all" || scope === "discovery") {
      delete this.oauthState.discoveryState;
    }

    const hasState = Object.values(this.oauthState).some((value) => value !== undefined);

    if (!hasState) {
      await rm(this.storagePath, { force: true }).catch(() => undefined);
      return;
    }

    await this.persist();
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.oauthState.discoveryState;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.oauthState.discoveryState = state;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await ensureDirectory(path.dirname(this.storagePath));
    await writeFile(this.storagePath, `${JSON.stringify(this.oauthState, null, 2)}\n`, "utf8");
  }
}

async function loadOAuthState(storagePath: string): Promise<OAuthStateFile> {
  try {
    const raw = await readFile(storagePath, "utf8");
    return JSON.parse(raw) as OAuthStateFile;
  } catch (error) {
    const message = ensureError(error).message;

    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw new AppError(`Failed to load persisted Figma MCP OAuth state. ${message}`, {
      code: "figma_mcp_oauth_state_invalid",
      cause: error,
    });
  }
}

async function oauthStatePath(serverUrl: string): Promise<string> {
  const digest = createHash("sha256").update(serverUrl).digest("hex").slice(0, 16);
  const dir = path.join(resolveConfigDir(), "oauth");
  await ensureDirectory(dir);
  return path.join(dir, `figma-${digest}.json`);
}

function resolveConfigDir(): string {
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "peye");
  }

  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "peye");
  }

  return path.join(os.homedir(), ".config", "peye");
}

async function createOAuthCallbackServer(): Promise<OAuthCallbackServer> {
  const deferred = createDeferred<string>();
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const authorizationCode = requestUrl.searchParams.get("code");
    const error = requestUrl.searchParams.get("error");

    if (authorizationCode) {
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        "<html><body><h1>Authorization complete</h1><p>You can close this window.</p></body></html>",
      );
      deferred.resolve(authorizationCode);
      return;
    }

    if (error) {
      response.statusCode = 400;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<html><body><h1>Authorization failed</h1><p>${error}</p></body></html>`);
      deferred.reject(new Error(`OAuth authorization failed: ${error}`));
      return;
    }

    response.statusCode = 400;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<html><body><h1>Invalid callback</h1></body></html>");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new AppError("Failed to start local OAuth callback server.", {
      code: "figma_mcp_oauth_callback_failed",
    });
  }

  return {
    redirectUrl: `http://127.0.0.1:${address.port}/callback`,
    waitForAuthorizationCode: async () => {
      return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new AppError("Timed out waiting for the Figma MCP OAuth callback.", {
              code: "figma_mcp_oauth_timeout",
            }),
          );
        }, DEFAULT_FIGMA_OAUTH_TIMEOUT_MS);
        timeout.unref?.();

        deferred.promise.then(
          (code) => {
            clearTimeout(timeout);
            resolve(code);
          },
          (error) => {
            clearTimeout(timeout);
            reject(ensureError(error));
          },
        );
      });
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

function createDeferred<TValue>(): Deferred<TValue> {
  let resolve!: (value: TValue) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<TValue>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return {
    promise,
    reject,
    resolve,
  };
}

function openExternalUrl(url: string): void {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];

  const [file, ...args] = command;

  try {
    const child = spawn(file, args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", () => {
      process.stderr.write("Open the authorization URL manually if the browser did not start.\n");
    });
    child.unref();
  } catch {
    process.stderr.write(`Open the authorization URL manually if the browser did not start.\n`);
  }
}
