import { BaseAgent } from './base-agent';
import { ReviewCategory } from '../types';

export class ArchitectureAgent extends BaseAgent {
  readonly name = 'architecture';
  readonly category: ReviewCategory = 'architecture';
  readonly displayName = 'Architecture';
  readonly icon = '\uD83C\uDFD7\uFE0F';
}
