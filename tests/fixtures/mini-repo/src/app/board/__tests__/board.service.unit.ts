import { BoardService } from '../board.service';
import { User } from '../../user.model';

// A unit-test caller of BoardService — legitimate usage, but must rank BELOW
// production callers and never crowd them out of the caller budget.
describe('BoardService', () => {
  it('exports csv', () => {
    const svc = new BoardService();
    const user = {} as User;
    const csv = svc.exportCsv(user);
    expect(csv.rows.length).toBeGreaterThanOrEqual(0);
  });
});
