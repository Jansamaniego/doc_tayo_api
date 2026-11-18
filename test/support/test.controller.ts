import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  IsEmail,
  IsInt,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Public } from '../../src/common/decorators/public.decorator.js';
import { DomainError } from '../../src/common/errors/domain-error.js';
import { Prisma } from '../../src/generated/prisma/client.js';

class AddressDto {
  @IsString() @MaxLength(10) city!: string;
}

export class ItemDto {
  @IsEmail() email!: string;
  @IsInt() @Min(1) quantity!: number;
  @ValidateNested() @Type(() => AddressDto) address!: AddressDto;
}

/** Test-only controller; registered by createTestApp, never by src/. */
@Public()
@Controller({ path: '_test', version: '1' })
export class TestController {
  @Post('items')
  create(@Body() body: ItemDto) {
    return { data: { email: body.email } };
  }

  @Get('domain-error')
  domainError() {
    throw new DomainError('CONFLICT');
  }

  @Get('unexpected')
  unexpected() {
    throw new Error(
      'secret-sql SELECT * FROM patients postgres://user:pw@db-host/doc_tayo TOKEN-LEAK-123',
    );
  }

  @Get('prisma-unique')
  prismaUnique() {
    throw new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on users_email_key',
      {
        code: 'P2002',
        clientVersion: '7.10.1',
        meta: { target: ['email'] },
      },
    );
  }

  @Get('prisma-missing')
  prismaMissing() {
    throw new Prisma.PrismaClientKnownRequestError(
      'Record to update not found.',
      {
        code: 'P2025',
        clientVersion: '7.10.1',
      },
    );
  }

  @Get('prisma-other')
  prismaOther() {
    throw new Prisma.PrismaClientKnownRequestError(
      'internal detail pg_catalog',
      {
        code: 'P2010',
        clientVersion: '7.10.1',
        meta: { query: 'SELECT secret FROM t' },
      },
    );
  }

  @Get('echo-log')
  echoLog() {
    return { ok: true };
  }
}
