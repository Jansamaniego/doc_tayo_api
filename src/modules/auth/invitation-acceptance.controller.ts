import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator.js';
import { FIVE_PER_FIFTEEN } from './auth-throttle.js';
import { AcceptInvitationDto } from './dto/login.dto.js';
import { InvitationAcceptanceService } from './invitation-acceptance.service.js';

/** Public: the emailed token is the credential. Lives in `auth` (unscoped client). */
@ApiTags('invitations')
@Controller({ path: 'invitations', version: '1' })
export class InvitationAcceptanceController {
  constructor(private readonly acceptance: InvitationAcceptanceService) {}

  @Public()
  @Post('accept')
  @HttpCode(204)
  @Throttle({ default: FIVE_PER_FIFTEEN })
  @ApiNoContentResponse({
    description: 'Joined the clinic. Sign in next (no automatic sign-in).',
  })
  @ApiBadRequestResponse({ description: 'TOKEN_INVALID or VALIDATION_FAILED' })
  @ApiForbiddenResponse({
    description: 'TENANT_SUSPENDED or TENANT_DEACTIVATED',
  })
  async accept(@Body() dto: AcceptInvitationDto): Promise<void> {
    await this.acceptance.accept(dto.token, {
      fullName: dto.fullName,
      newPassword: dto.newPassword,
    });
  }
}
