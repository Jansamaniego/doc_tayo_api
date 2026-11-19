import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsUUID, MaxLength } from 'class-validator';

export class InvitationIdParams {
  @IsUUID() invitationId!: string;
}

export class CreateInvitationDto {
  @ApiProperty({ example: 'new.doctor@clinic.example' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'A role of this clinic (not owner).',
  })
  @IsUUID()
  roleId!: string;
}

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export class InvitationResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ format: 'uuid' }) roleId!: string;
  @ApiProperty({ enum: ['pending', 'accepted', 'revoked', 'expired'] })
  status!: InvitationStatus;
  @ApiProperty() expiresAt!: Date;
  @ApiProperty() createdAt!: Date;
}

export class InvitationEnvelope {
  @ApiProperty({ type: InvitationResponse }) data!: InvitationResponse;
}

/** Never includes the token or its hash. */
export function toInvitationResponse(
  row: {
    id: string;
    email: string;
    roleId: string;
    expiresAt: Date;
    createdAt: Date;
    acceptedAt: Date | null;
    revokedAt: Date | null;
  },
  now: Date,
): InvitationResponse {
  const status: InvitationStatus = row.acceptedAt
    ? 'accepted'
    : row.revokedAt
      ? 'revoked'
      : row.expiresAt <= now
        ? 'expired'
        : 'pending';
  return {
    id: row.id,
    email: row.email,
    roleId: row.roleId,
    status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}
