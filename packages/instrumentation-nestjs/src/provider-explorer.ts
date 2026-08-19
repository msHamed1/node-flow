import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { shouldInstrumentProvider } from './filter.js';
import {
  instrumentProviderInstance,
  type InstanceInstrumentationResult,
} from './method-instrumentation.js';
import { NODESCOPE_OPTIONS, type ResolvedNodeScopeTracingOptions } from './options.js';

@Injectable()
export class NodeScopeProviderExplorer implements OnApplicationBootstrap {
  private results: InstanceInstrumentationResult[] = [];

  constructor(
    private readonly discoveryService: DiscoveryService,
    @Inject(NODESCOPE_OPTIONS) private readonly options: ResolvedNodeScopeTracingOptions,
  ) {}

  onApplicationBootstrap(): void {
    // Force controller discovery during bootstrap. Route methods are represented
    // by the global interceptor to avoid wrapping the handler already traced by
    // the official NestJS OpenTelemetry instrumentation.
    this.discoveryService.getControllers();

    this.results = this.discoveryService
      .getProviders()
      .filter((wrapper) => shouldInstrumentProvider(wrapper, this.options))
      .map((wrapper) =>
        instrumentProviderInstance(wrapper.instance, wrapper.metatype.name, this.options),
      )
      .filter((result) => result.methods.length > 0);
  }

  getInstrumentationResults(): readonly InstanceInstrumentationResult[] {
    return this.results;
  }
}
