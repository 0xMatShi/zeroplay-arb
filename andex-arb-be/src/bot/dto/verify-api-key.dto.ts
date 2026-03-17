import { IsNumber, IsString } from 'class-validator';

export class VerifyApiKeyDto {
  @IsString()
  apiKey: string;

  @IsNumber()
  telegramUserId: number;
}
