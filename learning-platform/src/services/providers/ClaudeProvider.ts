import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, AIProviderConfig } from './AIProvider';
import { AIServiceError, AIErrorType } from '../aiService';

/**
 * Claude AI Provider
 * Handles all raw API calls to Anthropic Claude API
 */
export class ClaudeProvider implements AIProvider {
  private anthropic: Anthropic;
  private modelName: string;
  private temperature: number;
  private defaultMaxTokens: number;

  constructor(config: AIProviderConfig) {
    this.anthropic = new Anthropic({
      apiKey: config.apiKey,
      dangerouslyAllowBrowser: true // For browser usage
    });
    this.modelName = config.model || 'claude-sonnet-4-20250514';
    this.temperature = config.temperature ?? 0.5;
    this.defaultMaxTokens = config.defaultMaxTokens || 2000;
  }

  async generateContent(prompt: string, maxTokens?: number): Promise<string> {
    try {
      const response = await this.anthropic.messages.create({
        model: this.modelName,
        max_tokens: maxTokens || this.defaultMaxTokens,
        temperature: this.temperature,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      // Extract text content from Claude response
      const content = response.content[0];
      if (content.type === 'text') {
        const text = content.text.trim();

        if (!text) {
          throw new AIServiceError(
            AIErrorType.UNKNOWN,
            null,
            false,
            'Empty response from Claude API'
          );
        }

        return text;
      }

      throw new AIServiceError(
        AIErrorType.UNKNOWN,
        null,
        false,
        'Unexpected response format from Claude'
      );
    } catch (error: any) {
      console.error('Claude API error:', error);

      // Map Claude-specific errors
      if (error.status === 429) {
        throw new AIServiceError(AIErrorType.RATE_LIMIT, error, true, error.message);
      }
      if (error.status === 503 || error.status === 502) {
        throw new AIServiceError(AIErrorType.SERVICE_UNAVAILABLE, error, true, error.message);
      }
      if (error.status === 401 || error.status === 403) {
        throw new AIServiceError(AIErrorType.AUTHENTICATION, error, false, error.message);
      }

      throw AIServiceError.fromHttpError(error);
    }
  }

  getProviderName(): string {
    return 'Claude';
  }

  getModel(): string {
    return this.modelName;
  }
}
