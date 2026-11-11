import { Module } from '@nestjs/common';
import { VaultLedgerService } from './vault-ledger.service';
import { FractionalVaultService } from './fractional-vault.service';
import { EscrowLedgerController } from './escrow-ledger.controller';
import { FractionalVaultController } from './fractional-vault.controller';

@Module({
  controllers: [EscrowLedgerController, FractionalVaultController],
  providers: [VaultLedgerService, FractionalVaultService],
  exports: [VaultLedgerService, FractionalVaultService],
})
export class LedgerModule {}
