import { Module } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AUTHENTICATOR } from '../../common/auth/authenticator.js';
import { AuditModule } from '../audit/audit.module.js';
import { MailModule } from '../mail/mail.module.js';
import { AccountSetupService } from './account-setup.service.js';
import { PasswordChangeService } from './password-change.service.js';
import { PasswordRecoveryService } from './password-recovery.service.js';
import { UserTokenService } from './user-token.service.js';
import {
  AccessTokenService,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './access-token.service.js';
import { authConfig } from '../../config/configuration.js';
import { AuthController } from './auth.controller.js';
import { InvitationAcceptanceController } from './invitation-acceptance.controller.js';
import { InvitationAcceptanceService } from './invitation-acceptance.service.js';
import { AuthCookieService } from './auth-cookie.service.js';
import { JwtAuthenticator } from './jwt.authenticator.js';
import { LoginService } from './login.service.js';
import { PasswordHasher } from './password-hasher.js';
import { SwitchTenantService } from './switch-tenant.service.js';
import { RefreshService } from './refresh.service.js';
import { SessionService } from './session.service.js';

@Module({
  imports: [
    AuditModule,
    MailModule,
    JwtModule.registerAsync({
      inject: [authConfig.KEY],
      useFactory: (auth: ConfigType<typeof authConfig>) => ({
        secret: auth.jwt.secret,
        signOptions: {
          algorithm: 'HS256',
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        },
        verifyOptions: {
          algorithms: ['HS256'],
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        },
      }),
    }),
  ],
  controllers: [AuthController, InvitationAcceptanceController],
  providers: [
    {
      provide: PasswordHasher,
      inject: [authConfig.KEY],
      useFactory: (auth: ConfigType<typeof authConfig>) =>
        new PasswordHasher(auth.argon2),
    },
    AuthCookieService,
    LoginService,
    SwitchTenantService,
    UserTokenService,
    PasswordRecoveryService,
    AccountSetupService,
    PasswordChangeService,
    InvitationAcceptanceService,
    AccessTokenService,
    SessionService,
    RefreshService,
    { provide: AUTHENTICATOR, useClass: JwtAuthenticator },
  ],
  exports: [
    AUTHENTICATOR,
    AccessTokenService,
    SessionService,
    RefreshService,
    PasswordHasher,
    UserTokenService,
    PasswordChangeService,
    JwtModule,
  ],
})
export class AuthModule {}
