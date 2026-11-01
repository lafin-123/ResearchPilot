import type { ResearchPilotApi } from '../shared/api'

declare global {
  interface Window {
    researchpilot: ResearchPilotApi
  }
}

export {}
