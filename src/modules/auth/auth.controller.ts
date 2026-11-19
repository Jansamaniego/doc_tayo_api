import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator.js';
import { TenantNotRequired } from '../../common/decorators/tenant-not-required.decorator.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { RequestContext } from '../../context/request-context.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuthCookieService } from './session/auth-cookie.service.js';
import { FIVE_PER_FIFTEEN, IpLimited, ipAndEmailTracker } from './throttle.js';
import {
  AccountSetupDto,
  ForgotPasswordDto,
  LoginDto,
  ResetPasswordDto,
  SwitchTenantDto,
} from './dto/login.dto.js';
import { AccountSetupService } from './flows/account-setup.service.js';
import { PasswordRecoveryService } from './flows/password-recovery.service.js';
import {
  AcceptedEnvelope,
  LoginEnvelope,
  RefreshEnvelope,
  SwitchTenantEnvelope,
} from './dto/auth-response.dto.js';
import { LoginService } from './flows/login.service.js';
import { RefreshService } from './session/refresh.service.js';
import { SessionService } from './session/session.service.js';
import { SwitchTenantService } from './flows/switch-tenant.service.js';

@ApiTags('auth')
@ApiTooManyRequestsResponse({ description: 'RATE_LIMITED (see Retry-After)' })
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly login: LoginService,
    private readonly refresh: RefreshService,
    private readonly sessions: SessionService,
    private readonly switchTenant: SwitchTenantService,
    private readonly cookies: AuthCookieService,
    private readonly recovery: PasswordRecoveryService,
    private readonly accountSetup: AccountSetupService,
    private readonly context: RequestContext,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @IpLimited()
  @Throttle({ default: { ...FIVE_PER_FIFTEEN, getTracker: ipAndEmailTracker } })
  @ApiOkResponse({
    type: LoginEnvelope,
    description:
      'Access token, user and memberships. The refresh token is set in an HttpOnly cookie, never in the body.',
  })
  @ApiUnauthorizedResponse({ description: 'INVALID_CREDENTIALS' })
  async signIn(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.login.login({
      email: dto.email,
      password: dto.password,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    this.cookies.set(res, result.refreshToken, result.absoluteExpiresAt);
    return {
      data: {
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
        user: result.user,
        memberships: result.memberships,
        activeTenantId: result.activeTenantId,
      },
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOkResponse({
    type: RefreshEnvelope,
    description: 'A new access token; the cookie is rotated.',
  })
  @ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED' })
  async refreshSession(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.cookies.assertAllowedOrigin(req);
    const token = this.cookies.read(req);
    if (!token) throw new DomainError('UNAUTHENTICATED');
    const rotated = await this.refresh.rotate(token);
    this.cookies.set(res, rotated.refreshToken, rotated.absoluteExpiresAt);
    return {
      data: { accessToken: rotated.accessToken, expiresIn: rotated.expiresIn },
    };
  }

  @TenantNotRequired()
  @Post('logout')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'The current session is revoked.' })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    this.cookies.assertAllowedOrigin(req);
    const userId = this.context.requireUser();
    const sessionId = this.context.sessionId!;
    await this.prisma.$transaction(async (tx) => {
      await this.sessions.revoke(tx, { sessionId, reason: 'logout' });
      await this.audit.recordAccountEvent(tx, {
        action: 'auth.logout',
        userId,
        entityType: 'session',
        entityId: sessionId,
      });
    });
    this.cookies.clear(res);
  }

  @TenantNotRequired()
  @Post('logout-all')
  @HttpCode(204)
  @ApiNoContentResponse({
    description: 'Every session of the user is revoked.',
  })
  async logoutAll(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    this.cookies.assertAllowedOrigin(req);
    const userId = this.context.requireUser();
    await this.prisma.$transaction(async (tx) => {
      await this.sessions.revokeAllForUser(tx, {
        userId,
        reason: 'logout_all',
      });
      await this.audit.recordAccountEvent(tx, {
        action: 'auth.logout_all',
        userId,
      });
    });
    this.cookies.clear(res);
  }

  @TenantNotRequired()
  @Post('switch-tenant')
  @HttpCode(200)
  @ApiOkResponse({
    type: SwitchTenantEnvelope,
    description:
      'The new active clinic and the permissions held there. Applies from the next request.',
  })
  async switchActiveTenant(@Body() dto: SwitchTenantDto) {
    return { data: await this.switchTenant.switch(dto) };
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(202)
  @Throttle({ default: FIVE_PER_FIFTEEN })
  @ApiAcceptedResponse({
    type: AcceptedEnvelope,
    description:
      'Always 202, whether or not the email has an account (no enumeration).',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.recovery.forgot(dto.email);
    return { data: { accepted: true } };
  }

  @Public()
  @Post('password/reset')
  @HttpCode(204)
  @Throttle({ default: FIVE_PER_FIFTEEN })
  @ApiNoContentResponse({
    description: 'Password set; every session of the user is revoked.',
  })
  @ApiBadRequestResponse({ description: 'TOKEN_INVALID or VALIDATION_FAILED' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.recovery.reset(dto);
  }

  @Public()
  @Post('account/setup')
  @HttpCode(204)
  @Throttle({ default: FIVE_PER_FIFTEEN })
  @ApiNoContentResponse({ description: 'Account activated; sign in next.' })
  @ApiBadRequestResponse({ description: 'TOKEN_INVALID or VALIDATION_FAILED' })
  async setUpAccount(@Body() dto: AccountSetupDto): Promise<void> {
    await this.accountSetup.setup(dto);
  }
}
