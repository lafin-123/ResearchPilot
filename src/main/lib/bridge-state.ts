export interface BridgeEndpoint {
  url: string
  token: string
}

let endpoint: BridgeEndpoint | undefined

export function setBridgeEndpoint(next: BridgeEndpoint): void {
  endpoint = next
}

export function getBridgeEndpoint(): BridgeEndpoint | undefined {
  return endpoint
}
