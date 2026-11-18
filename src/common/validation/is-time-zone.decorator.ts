import { registerDecorator, type ValidationOptions } from 'class-validator';
import { isValidTimeZone } from './timezone.js';

/** The value must be a canonical IANA time zone name (e.g. `Asia/Manila`). */
export function IsTimeZone(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) =>
    registerDecorator({
      name: 'isTimeZone',
      target: target.constructor,
      propertyName: propertyKey as string,
      ...(options ? { options } : {}),
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && isValidTimeZone(value),
      },
    });
}
