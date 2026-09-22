import { IndexSettings } from "@opensearch-project/opensearch/api/_types/indices._common";
import { TypeMapping } from "@opensearch-project/opensearch/api/_types/_common.mapping";

// One versioned index definition — matches the body of client.indices.create({ index, body }); settings holds number_of_shards / number_of_replicas, mappings.properties is the field map.
export interface IndexMapping {
  settings: IndexSettings;
  mappings: TypeMapping;
}
