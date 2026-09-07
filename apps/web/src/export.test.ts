import { describe, expect, it } from 'vitest';
import { parseImport, type ExpenseDto, type MemberDto, type PaymentDto } from '@spendapp/shared';
import { toCsv } from './export';

const members: MemberDto[] = [
  { userId: 'u1', displayName: 'Ada', role: 'admin' } as MemberDto,
  { userId: 'u2', displayName: 'Grace', role: 'member' } as MemberDto,
];
const resolve = (id: string) => id;

function expense(over: Partial<ExpenseDto>): ExpenseDto {
  return {
    id: 'e1',
    groupId: 'g1',
    description: 'Lunch',
    category: 'food',
    currency: 'EUR',
    amountMinor: 1000,
    expenseDate: '2026-01-02',
    note: '',
    createdBy: 'u1',
    splits: [{ userId: 'u1', paidMinor: 1000, owedMinor: 1000 }],
    ...over,
  } as ExpenseDto;
}

const csv = (e: Partial<ExpenseDto>) => toCsv([expense(e)], [] as PaymentDto[], members, resolve);

describe('csv export', () => {
  it('neutralises a formula a co-member typed into a description', () => {
    // Opened in a spreadsheet this would otherwise run on the exporter's machine.
    const out = csv({ description: '=HYPERLINK("https://evil.example","refund")' });
    expect(out).toContain(`"'=HYPERLINK`);
    expect(out).not.toMatch(/,=HYPERLINK/);
  });

  it('neutralises every leading character a spreadsheet treats as a formula', () => {
    for (const lead of ['=', '+', '-', '@']) {
      const out = csv({ note: `${lead}cmd|' /C calc'!A1` });
      expect(out).toContain(`"'${lead}cmd`);
    }
  });

  it('leaves a negative amount alone — it is money, not a formula', () => {
    // The guard must not turn -12.34 EUR into text, or sums stop working.
    const out = csv({ amountMinor: -1234, splits: [{ userId: 'u1', paidMinor: -1234, owedMinor: -1234 }] });
    expect(out).toContain('-12.34 EUR');
    expect(out).not.toContain(`'-12.34`);
  });

  it('still quotes commas and quotes the ordinary way', () => {
    expect(csv({ description: 'Lunch, twice' })).toContain('"Lunch, twice"');
    expect(csv({ description: 'He said "hi"' })).toContain('"He said ""hi"""');
  });
});

/**
 * The half of the contract the export side alone cannot check.
 *
 * `toCsv` and the importer are the two ends of one format, and they were free
 * to drift: the importer's own tests used a hand-written fixture rather than
 * this function's output, so an export that no import could read passed both
 * suites. Reading a real export back is the only test that pins them together.
 */
describe('csv round trip', () => {
  it('reads back an export of its own', () => {
    const lunch = expense({
      splits: [
        { userId: 'u1', paidMinor: 1000, owedMinor: 400 },
        { userId: 'u2', paidMinor: 0, owedMinor: 600 },
      ],
    });
    const settle = {
      id: 'p1',
      groupId: 'g1',
      fromUser: 'u2',
      toUser: 'u1',
      currency: 'EUR',
      amountMinor: 600,
      paidOn: '2026-01-03',
      note: 'settling',
      createdBy: 'u2',
    } as PaymentDto;

    const parsed = parseImport(toCsv([lunch], [settle], members, resolve));

    expect(parsed.format).toBe('spendapp');
    expect(parsed.warnings).toEqual([]);
    expect(parsed.members).toEqual(['Ada', 'Grace']);
    expect(parsed.entries).toEqual([
      {
        kind: 'expense',
        date: '2026-01-02',
        description: 'Lunch',
        category: 'food',
        currency: 'EUR',
        amountMinor: 1000,
        note: '',
        splits: [
          { member: 'Ada', paidMinor: 1000, owedMinor: 400 },
          { member: 'Grace', paidMinor: 0, owedMinor: 600 },
        ],
      },
      {
        kind: 'payment',
        date: '2026-01-03',
        from: 'Grace',
        to: 'Ada',
        currency: 'EUR',
        amountMinor: 600,
        note: 'settling',
      },
    ]);
  });

  it('survives a currency whose minor unit is not two digits', () => {
    // "1234 JPY" has no decimal point at all, and 1.234 KWD has three.
    const yen = expense({
      currency: 'JPY',
      amountMinor: 1234,
      splits: [{ userId: 'u1', paidMinor: 1234, owedMinor: 1234 }],
    });
    const [back] = parseImport(toCsv([yen], [], members, resolve)).entries;
    expect(back).toMatchObject({ currency: 'JPY', amountMinor: 1234 });
  });
});
