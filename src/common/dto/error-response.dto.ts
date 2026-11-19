import { ApiProperty } from '@nestjs/swagger';
import { ERROR_CODES, FIELD_ERROR_CODES } from '../errors/error-codes.js';

/** One problem with one request field (`VALIDATION_FAILED` details). */
export class FieldErrorBody {
  @ApiProperty({ example: 'newPassword' }) field!: string;
  @ApiProperty({
    enum: Object.keys(FIELD_ERROR_CODES),
    enumName: 'FieldErrorCode',
  })
  code!: string;
  @ApiProperty({ description: 'Static, user-safe text; never echoes input.' })
  message!: string;
}

export class ErrorBody {
  @ApiProperty({ example: 400, description: 'The HTTP status.' })
  status!: number;
  @ApiProperty({ enum: Object.keys(ERROR_CODES), enumName: 'ErrorCode' })
  code!: string;
  @ApiProperty({ description: 'Static, user-safe text.' })
  message!: string;
  @ApiProperty({
    type: [FieldErrorBody],
    required: false,
    description: 'Present for VALIDATION_FAILED.',
  })
  details?: FieldErrorBody[];
  @ApiProperty({
    format: 'uuid',
    description: 'Also the X-Request-Id response header; quote it to support.',
  })
  requestId!: string;
}

/** The body of every 4xx and 5xx response. */
export class ErrorResponse {
  @ApiProperty({ type: ErrorBody }) error!: ErrorBody;
}
