package dev.deja.core.trajectory;

import java.util.Map;

/**
 * An asserted client action extracted from a cassette's wire frames.
 *
 * @param index      position among included client actions
 * @param method     JSON-RPC/MCP method
 * @param toolName   present only for {@code tools/call}
 * @param params     canonical-comparison input (post normalization, so {@code _meta}/id already stripped)
 * @param frameIndex original wire provenance -- diagnostic only, never a matching key
 * @param tMs        original wire provenance -- diagnostic only, never a matching key
 */
public record TrajectoryStep(int index, String method, String toolName, Map<String, Object> params, int frameIndex, long tMs) {
}
