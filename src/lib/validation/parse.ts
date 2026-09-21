import type { ZodSchema } from "zod";
import { ZodError } from "zod";
import { ApiError } from "@/lib/api/errors";
import { fieldErrorsFrom } from "@/lib/validation/schemas";

export async function parseBody<T>(request: Request, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    const text = await request.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError("INVALID_JSON", "The request body was not valid JSON.", 400);
  }
  return parseInput(schema, raw);
}

export function parseInput<T>(schema: ZodSchema<T>, raw: unknown): T {
  try {
    return schema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ApiError(
        "VALIDATION_ERROR",
        error.issues[0]?.message ?? "Please check the information you entered.",
        422,
        { fields: fieldErrorsFrom(error) },
      );
    }
    throw error;
  }
}

export function parseQuery<T>(url: string, schema: ZodSchema<T>): T {
  const params = new URL(url).searchParams;
  const raw: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    raw[key] = value;
  }
  return parseInput(schema, raw);
}
