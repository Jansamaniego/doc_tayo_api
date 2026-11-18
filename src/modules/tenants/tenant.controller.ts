import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator.js';
import { PERMISSIONS } from '../access-control/catalog.js';
import {
  TenantEnvelope,
  UpdateTenantDto,
  toTenantResponse,
} from './dto/tenant.dto.js';
import { TenantProfileService } from './tenant-profile.service.js';

@ApiTags('tenant')
@ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED' })
@ApiForbiddenResponse({
  description:
    'FORBIDDEN, TENANT_NOT_SELECTED, TENANT_SUSPENDED, TENANT_DEACTIVATED or TENANT_ACCESS_DENIED',
})
@Controller({ path: 'tenant', version: '1' })
export class TenantController {
  constructor(private readonly profile: TenantProfileService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: TenantEnvelope, description: 'The active clinic.' })
  async get() {
    return { data: toTenantResponse(await this.profile.get()) };
  }

  @Patch()
  @RequirePermissions(PERMISSIONS.TENANT_SETTINGS_MANAGE)
  @ApiOkResponse({ type: TenantEnvelope, description: 'The updated clinic.' })
  async update(@Body() dto: UpdateTenantDto) {
    return { data: toTenantResponse(await this.profile.update(dto)) };
  }
}
