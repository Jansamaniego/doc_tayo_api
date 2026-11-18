import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator.js';
import { PERMISSIONS } from '../access-control/catalog.js';
import { BranchesService } from './branches.service.js';
import {
  BranchEnvelope,
  BranchIdParams,
  BranchListEnvelope,
  CreateBranchDto,
  ListBranchesQuery,
  UpdateBranchDto,
  toBranchResponse,
} from './dto/branch.dto.js';

@ApiTags('branches')
@ApiUnauthorizedResponse({ description: 'UNAUTHENTICATED' })
@ApiForbiddenResponse({
  description:
    'FORBIDDEN, TENANT_NOT_SELECTED, TENANT_SUSPENDED, TENANT_DEACTIVATED or TENANT_ACCESS_DENIED',
})
@Controller({ path: 'branches', version: '1' })
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.BRANCHES_READ)
  @ApiOkResponse({ type: BranchListEnvelope })
  async list(@Query() query: ListBranchesQuery) {
    const { rows, meta } = await this.branches.list(query);
    return { data: rows.map(toBranchResponse), meta };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSIONS.BRANCHES_MANAGE)
  @ApiCreatedResponse({ type: BranchEnvelope })
  @ApiConflictResponse({
    description: 'CONFLICT_UNIQUE: the name is taken in this clinic.',
  })
  async create(@Body() dto: CreateBranchDto) {
    return { data: toBranchResponse(await this.branches.create(dto)) };
  }

  @Get(':branchId')
  @RequirePermissions(PERMISSIONS.BRANCHES_READ)
  @ApiOkResponse({ type: BranchEnvelope })
  @ApiNotFoundResponse({
    description: "NOT_FOUND (also for another clinic's branch).",
  })
  async get(@Param() params: BranchIdParams) {
    return { data: toBranchResponse(await this.branches.get(params.branchId)) };
  }

  @Patch(':branchId')
  @RequirePermissions(PERMISSIONS.BRANCHES_MANAGE)
  @ApiOkResponse({ type: BranchEnvelope })
  @ApiNotFoundResponse({
    description: "NOT_FOUND (also for another clinic's branch).",
  })
  @ApiConflictResponse({
    description: 'CONFLICT_UNIQUE: the name is taken in this clinic.',
  })
  async update(@Param() params: BranchIdParams, @Body() dto: UpdateBranchDto) {
    return {
      data: toBranchResponse(await this.branches.update(params.branchId, dto)),
    };
  }
}
