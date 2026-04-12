import { BaseAgent } from './base-agent';
import { ReviewCategory } from '../types';

export class TestingAgent extends BaseAgent {
  readonly name = 'testing';
  readonly category: ReviewCategory = 'testing';
  readonly displayName = 'Testing';
  readonly icon = '\uD83E\uDDEA';
}
