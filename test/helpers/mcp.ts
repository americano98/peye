import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { buffer as readStreamBuffer } from "node:stream/consumers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TestServer } from "./http.js";

type MockScreenshotResult = {
  content: Array<
    { type: "image"; data: string; mimeType: string } | { type: "text"; text: string }
  >;
  isError?: boolean;
};

type MockMetadataResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export interface MockMcpServerOptions {
  exposeScreenshotTool?: boolean;
  onScreenshotCall?: () => void;
  responseFactory?: () => Promise<MockScreenshotResult> | MockScreenshotResult;
  metadataResponseFactory?: () => Promise<MockMetadataResult> | MockMetadataResult;
}

export async function startMockFigmaMcpServer(
  options: MockMcpServerOptions = {},
): Promise<TestServer> {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.url !== "/mcp") {
          response.statusCode = 404;
          response.end("not found");
          return;
        }

        if (request.method === "GET" || request.method === "DELETE") {
          response.statusCode = 405;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Method not allowed.",
              },
              id: null,
            }),
          );
          return;
        }

        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("method not allowed");
          return;
        }

        const parsedBody = await readJsonBody(request);
        const mcpServer = new McpServer({
          name: "mock-figma-mcp",
          version: "1.0.0",
        });

        if (options.exposeScreenshotTool !== false) {
          mcpServer.registerTool(
            "get_screenshot",
            {
              description: "Returns a mocked Figma screenshot.",
            },
            async () => {
              options.onScreenshotCall?.();

              if (options.responseFactory) {
                return await options.responseFactory();
              }

              return {
                content: [],
              };
            },
          );
        }

        if (options.metadataResponseFactory) {
          const metadataResponseFactory = options.metadataResponseFactory;
          mcpServer.registerTool(
            "get_metadata",
            {
              description: "Returns mocked Figma metadata.",
            },
            async () => {
              return await metadataResponseFactory();
            },
          );
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);

        await mcpServer.connect(transport as Transport);
        await transport.handleRequest(request, response, parsedBody);
        response.on("close", () => {
          void transport.close();
          void mcpServer.close();
        });
      } catch (error) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : "Internal server error",
            },
            id: null,
          }),
        );
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://${address.address}:${address.port}`,
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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const body = await readStreamBuffer(request);

  if (body.length === 0) {
    return undefined;
  }

  return JSON.parse(body.toString("utf8")) as unknown;
}
