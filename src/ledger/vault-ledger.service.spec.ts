import { VaultLedgerService } from './vault-ledger.service';
import { PrismaService } from '../database/prisma.service';
import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';

describe('VaultLedgerService', () => {
  let service: VaultLedgerService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      $transaction: jest.fn((cb) => cb(mockPrisma)),
      ledgerAccount: {
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      journalTransaction: {
        create: jest.fn().mockResolvedValue({ id: 'tx_123' }),
      },
      ledgerEntry: {
        create: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest.fn().mockImplementation((_query: any) => {
        return Promise.resolve([
          { id: 'acc_1', balance: '100.0000', type: 'LIABILITY' },
        ]);
      }),
    };

    service = new VaultLedgerService(mockPrisma as PrismaService);
  });

  it('should reject unbalanced journal entries (Debits != Credits)', async () => {
    await expect(
      service.postBalancedJournal(mockPrisma, {
        idempotencyKey: 'test_unbalanced',
        referenceType: 'TEST',
        referenceId: 'ref_1',
        description: 'Unbalanced test',
        legs: [
          {
            accountCode: 'ASSET:GATEWAY:EGP',
            accountName: 'Gateway',
            accountType: 'ASSET',
            currency: 'EGP',
            direction: 'DEBIT',
            amount: 100,
          },
          {
            accountCode: 'LIABILITY:USER_ESCROW:u1:EGP',
            accountName: 'User Escrow',
            accountType: 'LIABILITY',
            currency: 'EGP',
            direction: 'CREDIT',
            amount: 90, // Unbalanced!
          },
        ],
      }),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('should reject non-positive amounts (<= 0)', async () => {
    await expect(
      service.postBalancedJournal(mockPrisma, {
        idempotencyKey: 'test_zero_amount',
        referenceType: 'TEST',
        referenceId: 'ref_1',
        description: 'Zero amount test',
        legs: [
          {
            accountCode: 'ASSET:GATEWAY:EGP',
            accountName: 'Gateway',
            accountType: 'ASSET',
            currency: 'EGP',
            direction: 'DEBIT',
            amount: 0,
          },
          {
            accountCode: 'LIABILITY:USER_ESCROW:u1:EGP',
            accountName: 'User Escrow',
            accountType: 'LIABILITY',
            currency: 'EGP',
            direction: 'CREDIT',
            amount: 0,
          },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject overdraft on customer liability accounts', async () => {
    // Current balance is 100, but attempting to debit (decrease liability) by 150
    mockPrisma.$queryRaw = jest
      .fn()
      .mockResolvedValue([
        { id: 'acc_1', balance: '100.0000', type: 'LIABILITY' },
      ]);

    await expect(
      service.postBalancedJournal(mockPrisma, {
        idempotencyKey: 'test_overdraft',
        referenceType: 'TEST',
        referenceId: 'ref_1',
        description: 'Overdraft test',
        legs: [
          {
            accountCode: 'LIABILITY:USER_ESCROW:u1:EGP',
            accountName: 'User Escrow',
            accountType: 'LIABILITY',
            currency: 'EGP',
            direction: 'DEBIT', // Liability decrease
            amount: 150,
          },
          {
            accountCode: 'REVENUE:GOLD_SALES:EGP',
            accountName: 'Gold Sales',
            accountType: 'REVENUE',
            currency: 'EGP',
            direction: 'CREDIT',
            amount: 150,
          },
        ],
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('should post balanced journal and record entries correctly', async () => {
    mockPrisma.$queryRaw = jest.fn().mockImplementation((_query: any) => {
      return Promise.resolve([
        { id: 'acc_1', balance: '500.0000', type: 'LIABILITY' },
      ]);
    });

    const res = await service.postBalancedJournal(mockPrisma, {
      idempotencyKey: 'test_balanced',
      referenceType: 'TEST',
      referenceId: 'ref_1',
      description: 'Balanced test',
      legs: [
        {
          accountCode: 'ASSET:GATEWAY:EGP',
          accountName: 'Gateway',
          accountType: 'ASSET',
          currency: 'EGP',
          direction: 'DEBIT',
          amount: 200,
        },
        {
          accountCode: 'LIABILITY:USER_ESCROW:u1:EGP',
          accountName: 'User Escrow',
          accountType: 'LIABILITY',
          currency: 'EGP',
          direction: 'CREDIT',
          amount: 200,
        },
      ],
    });

    expect(res.id).toBe('tx_123');
    expect(mockPrisma.journalTransaction.create).toHaveBeenCalled();
    expect(mockPrisma.ledgerEntry.create).toHaveBeenCalledTimes(2);
  });
});
