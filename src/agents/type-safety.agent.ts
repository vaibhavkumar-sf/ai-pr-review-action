import { BaseAgent } from './base-agent';
import { ReviewCategory } from '../types';

export class TypeSafetyAgent extends BaseAgent {
  readonly name = 'type-safety';
  readonly category: ReviewCategory = 'type-safety';
  readonly displayName = 'Type Safety & Docs';
  readonly icon = '\uD83D\uDCDD';
}
