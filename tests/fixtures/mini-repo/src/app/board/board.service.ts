import { BoardCsvDto } from './models';
import { User } from '@app/user.model';
import { formatDate } from '@acme/shared';

export class BoardService {
  exportCsv(user: User): BoardCsvDto {
    const dto = new BoardCsvDto();
    dto.rows.push([user.name, formatDate(new Date())]);
    return dto;
  }
}
