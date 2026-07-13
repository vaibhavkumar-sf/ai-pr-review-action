import { inject } from '@loopback/core';

export class TollgateService {
  constructor(@inject('datasources.pgdb') private dataSource: unknown) {}

  gate(): boolean {
    return this.dataSource !== undefined;
  }
}
