import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { TenantNotRequired } from '../../common/decorators/tenant-not-required.decorator.js';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard.js';
import { PasswordChangeService } from '../auth/flows/password-change.service.js';
import { MembershipListEnvelope } from '../tenancy/dto/membership.dto.js';
import {
  ChangePasswordDto,
  MeProfileEnvelope,
  SessionIdParams,
  SessionListEnvelope,
} from './dto/me.dto.js';
import { MeService } from './me.service.js';

@ApiTags('me')
@ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED' })
@TenantNotRequired()
@Controller({ path: 'me', version: '1' })
export class MeController {
  constructor(
    private readonly me: MeService,
    private readonly passwordChange: PasswordChangeService,
  ) {}

  @Get()
  @ApiOkResponse({
    type: MeProfileEnvelope,
    description:
      'The profile, the active clinic and the permissions held there.',
  })
  async get() {
    return { data: await this.me.profile() };
  }

  @Post('password')
  @HttpCode(204)
  @UseGuards(UserThrottleGuard)
  @ApiNoContentResponse({
    description:
      'Password changed. Other sessions are revoked; this one stays signed in.',
  })
  async changePassword(@Body() dto: ChangePasswordDto): Promise<void> {
    await this.passwordChange.change(dto.currentPassword, dto.newPassword);
  }

  @Get('memberships')
  @ApiOkResponse({
    type: MembershipListEnvelope,
    description:
      'Every clinic the user belongs to (removed memberships excluded).',
  })
  async memberships() {
    return { data: await this.me.listMemberships() };
  }

  @Get('sessions')
  @ApiOkResponse({
    type: SessionListEnvelope,
    description: 'Active sessions; the current one is flagged.',
  })
  async sessions() {
    return { data: await this.me.listSessions() };
  }

  @Delete('sessions/:sessionId')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'The session is revoked.' })
  @ApiNotFoundResponse({
    description: "NOT_FOUND (also for someone else's session).",
  })
  async revokeSession(@Param() params: SessionIdParams): Promise<void> {
    await this.me.revokeSession(params.sessionId);
  }
}
