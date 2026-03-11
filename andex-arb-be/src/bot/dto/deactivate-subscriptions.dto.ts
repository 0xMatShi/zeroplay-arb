import { IsArray, IsNumber } from 'class-validator';

export class DeactivateSubscriptionsDto {
  @IsArray()
  @IsNumber({}, { each: true })
  telegramUserIds: number[];
}
