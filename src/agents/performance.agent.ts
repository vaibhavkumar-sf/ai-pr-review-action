import { BaseAgent } from './base-agent';
import { ReviewCategory } from '../types';

export class PerformanceAgent extends BaseAgent {
  readonly name = 'performance';
  readonly category: ReviewCategory = 'performance';
  readonly displayName = 'Performance';
  readonly icon = '\u26A1';
}
