import { BaseAgent } from './base-agent';
import { ReviewCategory } from '../types';

export class SecurityAgent extends BaseAgent {
  readonly name = 'security';
  readonly category: ReviewCategory = 'security';
  readonly displayName = 'Security';
  readonly icon = '\uD83D\uDD12';
}
