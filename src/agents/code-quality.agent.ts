import { BaseAgent } from './base-agent';
import { ReviewCategory } from '../types';

export class CodeQualityAgent extends BaseAgent {
  readonly name = 'code-quality';
  readonly category: ReviewCategory = 'code-quality';
  readonly displayName = 'Code Quality';
  readonly icon = '\uD83D\uDCD0';
}
