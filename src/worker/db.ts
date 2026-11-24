interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown>;
}

export type Account = { id: string; nickname: string };
export type Profile = Account & { expertise: string[] };

export async function profile(db: Database, account: Account): Promise<Profile> {
  const { results } = await db.prepare(
    'SELECT category_id FROM user_expertise WHERE user_id = ? ORDER BY category_id'
  ).bind(account.id).all<{ category_id: string }>();
  return { id: account.id, nickname: account.nickname, expertise: results.map(row => row.category_id) };
}

export async function setExpertise(db: Database, account: Account, ids: string[]) {
  await db.batch([
    db.prepare('DELETE FROM user_expertise WHERE user_id = ?').bind(account.id),
    ...ids.map(id => db.prepare('INSERT INTO user_expertise (user_id, category_id) VALUES (?, ?)').bind(account.id, id)),
  ]);
}
