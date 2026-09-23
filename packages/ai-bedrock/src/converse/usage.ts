import { buildBaseUsage } from '@tanstack/ai'
import type { TokenUsage } from '@tanstack/ai'
import type { TokenUsage as ConverseTokenUsage } from '@aws-sdk/client-bedrock-runtime'

/**
 * Build normalized {@link TokenUsage} from a Converse `usage` object.
 *
 * `inputTokens` is the uncached part of the input only. Cache reads and writes
 * come as separate fields. Include them in the input total and keep their
 * breakdown on `promptTokensDetails`. Zero is kept. Bedrock leaves the
 * fields out when no checkpoint applied and sends 0 when one did (a served
 * checkpoint writes 0), so absent and zero are different results.
 */
export function buildConverseUsage(usage: ConverseTokenUsage): TokenUsage {
  const inputTokens =
    (usage.inputTokens ?? 0) +
    (usage.cacheReadInputTokens ?? 0) +
    (usage.cacheWriteInputTokens ?? 0)
  const outputTokens = usage.outputTokens ?? 0
  const result = buildBaseUsage({
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: inputTokens + outputTokens,
  })

  const cachedTokens = usage.cacheReadInputTokens
  const cacheWriteTokens = usage.cacheWriteInputTokens
  const promptTokensDetails = {
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  }
  if (Object.keys(promptTokensDetails).length > 0) {
    result.promptTokensDetails = promptTokensDetails
  }

  return result
}
