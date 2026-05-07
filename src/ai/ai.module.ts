import { Module } from '@nestjs/common';
import { AiParserService } from './ai-parser.service';

@Module({
  providers: [AiParserService],
  exports: [AiParserService],
})
export class AiModule {}
