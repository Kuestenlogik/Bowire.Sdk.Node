// JSON-RPC 2.0 wire shapes.

export interface Request {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface Response {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: ErrorObject;
}

export interface Notification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface ErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_INTERNAL = -32603;

export function ok(id: string | number | null, result: unknown): Response {
  return { jsonrpc: "2.0", id, result };
}

export function err(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): Response {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}
