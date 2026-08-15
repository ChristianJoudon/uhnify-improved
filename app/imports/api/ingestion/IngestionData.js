import { Mongo } from 'meteor/mongo';

/**
 * Internal ingestion read models.
 *
 * These collections are intentionally separate from EventsCollection and
 * ClubsCollection. The ingestion worker may propose facts here, but only a
 * future reviewed projection boundary may put anything into the public app.
 */
export const CommunitySources = new Mongo.Collection('community_sources');
export const SourceRuns = new Mongo.Collection('source_runs');
export const IngestionCandidates = new Mongo.Collection('ingestion_candidates');
export const SourceHealth = new Mongo.Collection('source_health');

export const INGESTION_PUBLICATIONS = Object.freeze({
  sources: 'ingestion.sources.admin',
  runs: 'ingestion.runs.admin',
  candidates: 'ingestion.candidates.admin',
  health: 'ingestion.health.admin',
});
