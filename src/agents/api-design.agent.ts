import { BaseAgent } from './base-agent';
import { ReviewCategory } from '../types';

export class ApiDesignAgent extends BaseAgent {
  readonly name = 'api-design';
  readonly category: ReviewCategory = 'api-design';
  readonly displayName = 'API Design';
  readonly icon = '\uD83C\uDF10';
}
