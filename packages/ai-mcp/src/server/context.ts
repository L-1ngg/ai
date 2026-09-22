/**
 * One question for the user.
 * `message` is the text the user sees.
 */
export type ToolInputRequest = {
  message: string
}

/**
 * The prompt for `ctx.sample`.
 * `messages` is the list the model reads.
 * Each item has `role` and `content`.
 */
export type SampleRequest = {
  messages: ReadonlyArray<{
    role: string
    content: string
  }>
}

type WaitForInput<TAnswer> = (request: ToolInputRequest) => Promise<TAnswer>

type SampleModel<TSample> = (request: SampleRequest) => Promise<TSample>

/**
 * Callbacks for one tool call.
 *
 * Era `2025` needs `waitForInput` and `clientSample`.
 * Era `2026` uses `sample` for the model result.
 * On a protocol 2026 retry, `inputAnswer` is the answer.
 */
export type ServerToolContextOptions<TAnswer, TSample> =
  | {
      era: '2025'
      waitForInput: WaitForInput<TAnswer>
      clientSample: SampleModel<TSample>
      sample?: SampleModel<TSample>
    }
  | {
      era: '2026'
      inputAnswer?: TAnswer
      sample?: SampleModel<TSample>
      clientSample?: SampleModel<TSample>
    }

/**
 * The tool stopped because it needs user input.
 *
 * `resultType` is `input_required`.
 * `request` is the object passed to `ctx.requestInput`.
 * Catch this error, then run the tool again with `inputAnswer`.
 * `ctx.requestInput` then returns that answer.
 *
 * @param request - The input request from the tool
 *
 * @example
 * try {
 *   await tool(ctx)
 * } catch (error) {
 *   if (error instanceof ToolInputRequiredError) {
 *     error.request
 *   }
 * }
 */
export class ToolInputRequiredError extends Error {
  readonly resultType = 'input_required' as const

  constructor(public readonly request: ToolInputRequest) {
    super(
      'The tool stopped because it needs input. ' +
        'Run the tool again with inputAnswer.',
    )
    this.name = 'ToolInputRequiredError'
  }
}

/**
 * Builds the context for one tool call.
 *
 * On era `2025`, `requestInput` waits on `waitForInput`.
 * The same tool call then continues with that answer.
 * If `inputAnswer` is absent on era `2026`, `requestInput` throws
 * {@link ToolInputRequiredError}.
 * If you pass `inputAnswer`, the tool runs again.
 * Then `requestInput` returns that answer.
 * Code before `requestInput` runs on both calls.
 *
 * On era `2025`, `sample` calls `clientSample`.
 * It does not call the `sample` adapter.
 * On era `2026`, `sample` calls the `sample` adapter.
 * It does not call `clientSample`.
 * If `sample` is absent on era `2026`, `ctx.sample` throws an Error.
 * The error message contains `sample`.
 *
 * @param options - The protocol era and the callbacks for that era
 *
 * @example
 * const ctx = createServerToolContext({
 *   era: '2025',
 *   waitForInput: async () => 'Paris',
 *   clientSample: async () => 'A short draft',
 * })
 * await ctx.requestInput({ message: 'Which city?' })
 */
export function createServerToolContext<TAnswer = unknown, TSample = unknown>(
  options: ServerToolContextOptions<TAnswer, TSample>,
) {
  return {
    /**
     * Asks the user for a value.
     *
     * On era `2025`, this waits on `waitForInput` and returns that answer.
     * If `inputAnswer` is absent on era `2026`, this throws
     * {@link ToolInputRequiredError}.
     * If `inputAnswer` is present, this returns that answer.
     *
     * @param request - The question for the user
     */
    async requestInput(request: ToolInputRequest) {
      if (options.era === '2025') {
        return options.waitForInput(request)
      }

      // No answer yet: this call ends as input required.
      if (options.inputAnswer === undefined) {
        throw new ToolInputRequiredError(request)
      }

      return options.inputAnswer
    },

    /**
     * Asks for a model result.
     *
     * On era `2025`, this calls `clientSample`.
     * On era `2026`, this calls the `sample` adapter.
     * If that adapter is absent, this throws an Error.
     * The message contains `sample`.
     *
     * @param request - The prompt for the model
     */
    async sample(request: SampleRequest) {
      if (options.era === '2025') {
        return options.clientSample(request)
      }

      if (options.sample === undefined) {
        throw new Error(
          'ctx.sample needs the sample adapter on protocol 2026. ' +
            'Pass sample to createServerToolContext.',
        )
      }

      return options.sample(request)
    },
  }
}
