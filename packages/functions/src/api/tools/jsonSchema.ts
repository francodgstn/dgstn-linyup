// ─── A tool's arguments as plain JSON Schema ────────────────────────────────
//
// For a front end that does not take zod: the in-app assistant hands these to
// Gemini as `parametersJsonSchema`. (The MCP SDK converts the zod shape itself.)
// The shape is the same one `parseInput` validates the call with, so what the
// model is asked to fill and what the tool accepts cannot drift apart.

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

type JsonSchema = Record<string, unknown>

/**
 * zod-to-json-schema's generic signature instantiates too deeply against these
 * shapes — the same wall api/openapi/document.ts works around — so it is called
 * through this alias.
 */
const toJsonSchema = zodToJsonSchema as unknown as (schema: z.ZodTypeAny, options: Record<string, unknown>) => JsonSchema

export function toolParametersJsonSchema(shape: z.ZodRawShape): JsonSchema {
  const schema = toJsonSchema(z.object(shape), { target: 'jsonSchema7', $refStrategy: 'none' })
  // The `$schema` marker describes the document, not the parameters, and model
  // function-calling APIs reject or ignore unknown top-level keywords.
  const { $schema: _dialect, ...parameters } = schema
  return parameters
}
