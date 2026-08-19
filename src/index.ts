/**
 * A2A client provider: delegates DSH subagent runs to a remote A2A agent over
 * JSON-RPC. The provider advertises no start-time capabilities because the
 * remote agent owns its own tools, depth, persona, and output schema.
 *
 * @module dsh-subagent-a2a
 */

import { randomUUID } from 'node:crypto'
import type { Context } from 'cordis'
import z from 'schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import { Role, TaskState } from '@a2a-js/sdk'
import type { Message, Part, SendMessageRequest, Task } from '@a2a-js/sdk'
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client'
import type { Client } from '@a2a-js/sdk/client'

export const name = 'dsh-subagent-a2a'
export const inject = ['subagents']

/** Config: how to reach and drive a remote A2A agent. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `a2a`). */
  providerName?: string
  /** Base URL of the remote A2A agent, e.g. `http://127.0.0.1:4123`. */
  url: string
  /** AgentCard path used by client discovery (default `/.well-known/agent.json`). */
  agentCardPath?: string
  /** Extra HTTP headers for every request (e.g. `Authorization`). */
  headers?: Record<string, string>
  /** Per-call timeout in milliseconds. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('a2a'),
  url: z.string().required(),
  agentCardPath: z.string().default('/.well-known/agent.json'),
  headers: z.dict(z.string()).default({}),
  timeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
})

/** The shape after schemastery applied the defaults (`timeoutMs` has none). */
type ResolvedConfig = Required<Omit<Config, 'timeoutMs'>> & Pick<Config, 'timeoutMs'>

/**
 * The A2A provider. Advertises NO start-time capabilities: a remote agent
 * cannot honor `outputSchema`/`maxDepth`/`toolFilter`/`persona` locally.
 */
class A2aSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  // Context contract: a remote A2A agent starts fresh; no parent conversation crosses the HTTP boundary.
  readonly inheritsParentContext = false

  constructor(readonly name: string, private readonly config: ResolvedConfig) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    if (request.signal.aborted) throw new Error('subagent request was aborted before the A2A agent started')
    const client = await this.createClient()
    const id = SessionId(randomUUID())
    const controller = new AbortController()
    const onAbort = (): void => { controller.abort() }
    request.signal.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    if (this.config.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, this.config.timeoutMs)
    }

    const result: Promise<SubagentResult> = (async () => {
      try {
        const sendResult = await client.sendMessage(
          buildSendRequest(request.prompt),
          {
            signal: controller.signal,
            serviceParameters: this.config.headers,
          },
        )
        return toSubagentResult(sendResult)
      } catch (error: unknown) {
        if (timedOut) return { output: [], stopReason: 'error' }
        if (controller.signal.aborted || request.signal.aborted) {
          return { output: [], stopReason: 'aborted' }
        }
        this.logError(error)
        return { output: [], stopReason: 'error' }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        request.signal.removeEventListener('abort', onAbort)
      }
    })()

    return {
      id,
      localAgent: undefined,
      result,
      dispose: (): Promise<void> => {
        if (timer !== undefined) clearTimeout(timer)
        controller.abort()
        request.signal.removeEventListener('abort', onAbort)
        return Promise.resolve()
      },
    }
  }

  private async createClient(): Promise<Client> {
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory()],
    })
    return factory.createFromUrl(this.config.url, this.config.agentCardPath)
  }

  private logError(error: unknown): void {
    // The seam forbids `result` rejecting; preserve the failure in a console
    // diagnostic because this provider has no Cordis logger handle.
    console.warn(`subagent-a2a "${this.name}": remote run failed: ${String(error)}`)
  }
}

export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  if (resolved.timeoutMs !== undefined && (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0)) {
    throw new TypeError('subagent-a2a timeoutMs must be a positive safe integer')
  }
  ctx.subagents.registerProvider(new A2aSubagentProvider(resolved.providerName, resolved))
}

/** Build an A2A `SendMessageRequest` from the harness prompt blocks. */
function buildSendRequest(prompt: ContentBlock[]): SendMessageRequest {
  return {
    tenant: '',
    message: {
      messageId: randomUUID(),
      contextId: '',
      taskId: '',
      role: Role.ROLE_USER,
      parts: promptToParts(prompt),
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: {
      acceptedOutputModes: ['text/plain'],
      taskPushNotificationConfig: undefined,
      historyLength: undefined,
      returnImmediately: false,
    },
    metadata: undefined,
  }
}

/** Convert DSH content blocks to A2A text parts; non-text blocks are dropped. */
function promptToParts(prompt: ContentBlock[]): Part[] {
  const parts: Part[] = []
  for (const block of prompt) {
    if (block.type === 'text' && block.text.length > 0) {
      parts.push({
        content: { $case: 'text', value: block.text },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      })
    }
  }
  return parts
}

/** Convert an A2A send result (Task or Message) to a harness subagent result. */
function toSubagentResult(result: Message | Task): SubagentResult {
  if (isTask(result)) {
    return {
      output: artifactToContentBlocks(result),
      stopReason: taskStateToStopReason(result.status?.state),
    }
  }
  return {
    output: partsToContentBlocks(result.parts),
    stopReason: 'completed',
  }
}

/** Narrow A2A send results to Tasks. */
function isTask(value: Message | Task): value is Task {
  return 'status' in value && 'artifacts' in value
}

/** Extract text from Task artifacts into DSH content blocks. */
function artifactToContentBlocks(task: Task): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const artifact of task.artifacts) {
    blocks.push(...partsToContentBlocks(artifact.parts))
  }
  return blocks
}

/** Convert A2A parts to DSH text content blocks. */
function partsToContentBlocks(parts: Part[]): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const part of parts) {
    const content = part.content
    if (content === undefined) continue
    if (content.$case === 'text') {
      blocks.push({ type: 'text', text: content.value })
    } else if (content.$case === 'data') {
      blocks.push({ type: 'text', text: JSON.stringify(content.value) })
    }
  }
  return blocks
}

/** Map an A2A terminal Task state to a harness stop reason. */
function taskStateToStopReason(state: TaskState | undefined): SubagentStopReason {
  switch (state) {
    case TaskState.TASK_STATE_COMPLETED:
      return 'completed'
    case TaskState.TASK_STATE_CANCELED:
      return 'aborted'
    case TaskState.TASK_STATE_REJECTED:
      return 'refusal'
    case TaskState.TASK_STATE_FAILED:
    case undefined:
    default:
      return 'error'
  }
}
