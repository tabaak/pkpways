-- PkpWays railway profile for Project OSRM.
--
-- This graph is used only for one-off static geometry generation. It is not a
-- production service and must never be added to the live Docker Compose stack.
api_version = 4

Set = require('lib/set')
Sequence = require('lib/sequence')
WayHandlers = require('lib/way_handlers')

local ROUTABLE_RAIL = Set {
  'rail',
  'light_rail',
  'narrow_gauge',
  'subway',
  'tram',
  'monorail',
  'preserved',
}

local RETIRED_RAIL = Set {
  'abandoned',
  'construction',
  'disused',
  'proposed',
}

function setup()
  return {
    properties = {
      weight_name = 'duration',
      max_speed_for_map_matching = 160 / 3.6,
      continue_straight_at_waypoint = true,
      use_turn_restrictions = false,
      u_turn_penalty = 0,
    },
    default_mode = mode.driving,
    default_speed = 40,
    oneway_handling = true,
    restrictions = Sequence {},
    speeds = Sequence {
      railway = {
        rail = 160,
        light_rail = 100,
        narrow_gauge = 60,
        subway = 90,
        tram = 60,
        monorail = 80,
        preserved = 30,
      },
    },
    service_speeds = {
      crossover = 50,
      siding = 20,
      spur = 12,
      yard = 10,
    },
    usage_speeds = {
      branch = 120,
      industrial = 30,
      military = 20,
      tourism = 40,
    },
    -- Keep the graph rail-only. Access restrictions on a railway are not
    -- vehicle-road restrictions; station-to-station paths need the mapped
    -- railway topology to remain connected through junctions and yards.
    avoid = Set { 'impassable' },
    classes = Sequence {},
  }
end

local function prefer_passenger_tracks(profile, way, result, data)
  local service_speed = profile.service_speeds[way:get_value_by_key('service')]
  local usage_speed = profile.usage_speeds[way:get_value_by_key('usage')]
  local maximum = math.min(service_speed or math.huge, usage_speed or math.huge)
  if maximum == math.huge then
    return
  end
  if result.forward_speed > 0 then
    result.forward_speed = math.min(result.forward_speed, maximum)
  end
  if result.backward_speed > 0 then
    result.backward_speed = math.min(result.backward_speed, maximum)
  end
end

function process_node(profile, node, result)
  -- Railway junction nodes must remain traversable. Barriers are intentionally
  -- ignored because railway=rail ways often cross station boundary features.
end

function process_way(profile, way, result)
  local railway = way:get_value_by_key('railway')
  if not railway or not ROUTABLE_RAIL[railway] or RETIRED_RAIL[railway] then
    return
  end

  local data = { railway = railway }
  local handlers = Sequence {
    WayHandlers.default_mode,
    WayHandlers.blocked_ways,
    WayHandlers.oneway,
    WayHandlers.speed,
    prefer_passenger_tracks,
    WayHandlers.startpoint,
    WayHandlers.names,
    WayHandlers.weights,
  }
  WayHandlers.run(profile, way, result, data, handlers)
end

function process_turn(profile, turn)
  turn.duration = 0
  turn.weight = 0
end

return {
  setup = setup,
  process_way = process_way,
  process_node = process_node,
  process_turn = process_turn,
}
