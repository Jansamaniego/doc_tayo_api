import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator.js';
import { Clock } from '../../common/security/clock.js';
import { PERMISSIONS } from '../access-control/catalog.js';
import {
  CreateInvitationDto,
  InvitationEnvelope,
  InvitationIdParams,
  toInvitationResponse,
} from './dto/invitation.dto.js';
import { InvitationsService } from './invitations.service.js';

@ApiTags('invitations')
@ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED' })
@ApiForbiddenResponse({
  description:
    'FORBIDDEN, TENANT_NOT_SELECTED, TENANT_SUSPENDED, TENANT_DEACTIVATED or TENANT_ACCESS_DENIED',
})
@Controller({ path: 'invitations', version: '1' })
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly clock: Clock,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.MEMBERS_INVITE)
  @ApiCreatedResponse({ type: InvitationEnvelope })
  @ApiNotFoundResponse({
    description: "NOT_FOUND (also for another clinic's role).",
  })
  @ApiConflictResponse({
    description:
      'CONFLICT (already a member) or CONFLICT_UNIQUE (an open invitation exists: resend it).',
  })
  @ApiUnprocessableEntityResponse({
    description: 'ROLE_NOT_ASSIGNABLE (owner).',
  })
  async create(@Body() dto: CreateInvitationDto) {
    const row = await this.invitations.create(dto);
    return { data: toInvitationResponse(row, this.clock.now()) };
  }

  @Post(':invitationId/resend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.MEMBERS_INVITE)
  @ApiOkResponse({ type: InvitationEnvelope })
  @ApiNotFoundResponse({
    description: "NOT_FOUND (also for another clinic's invitation).",
  })
  @ApiConflictResponse({
    description: 'CONFLICT: already accepted or revoked.',
  })
  async resend(@Param() params: InvitationIdParams) {
    const row = await this.invitations.resend(params.invitationId);
    return { data: toInvitationResponse(row, this.clock.now()) };
  }
}
