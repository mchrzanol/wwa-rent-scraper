import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { GeocodingService } from './geocoding.service';

@Module({
  providers: [RoutingService, GeocodingService],
  exports: [RoutingService, GeocodingService],
})
export class RoutingModule {}
