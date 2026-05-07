import { Global, Module } from '@nestjs/common';
import { loadConfig } from '../config/configuration';
import { APP_CONFIG } from '../config/app-config.token';
import { PlaywrightService } from './playwright.service';
import { ProxyRotationService } from './proxy-rotation.service';

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: loadConfig },
    ProxyRotationService,
    PlaywrightService,
  ],
  exports: [PlaywrightService, ProxyRotationService, APP_CONFIG],
})
export class PlaywrightModule {}
