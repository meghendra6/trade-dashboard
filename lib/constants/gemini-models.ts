/**
 * Gemini model configuration
 * Single source of truth for available Gemini models
 */

export const GEMINI_MODELS = [
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' },
] as const;

// Extract model names as a type
export type GeminiModelName = typeof GEMINI_MODELS[number]['value'];

// Default model
export const DEFAULT_GEMINI_MODEL: GeminiModelName = 'gemini-3.1-pro-preview';

// Helper to get all valid model names
export const VALID_MODEL_NAMES = GEMINI_MODELS.map(m => m.value);
