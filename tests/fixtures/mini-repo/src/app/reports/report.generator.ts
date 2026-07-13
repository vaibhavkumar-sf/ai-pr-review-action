import { BoardService } from '../board/board.service';
import { User } from '../user.model';

export class ReportGenerator {
  constructor(private boards: BoardService) {}

  generate(user: User): string {
    const csv = this.boards.exportCsv(user);
    const header = ['name', 'exported-at'].join(',');
    const body = csv.rows.map((row) => row.join(',')).join('\n');
    return `${header}\n${body}`;
  }

  unrelatedHelper(): number {
    const values = [1, 2, 3, 4, 5];
    const doubled = values.map((v) => v * 2);
    const filtered = doubled.filter((v) => v > 4);
    return filtered.reduce((sum, v) => sum + v, 0);
  }
}
