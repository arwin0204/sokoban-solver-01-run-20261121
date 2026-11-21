[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/arwin0204/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/arwin0204/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Sokoban, solved push by push

Entry for the [sokoban-solver-01-run-20261121 bounty on make.fun](https://make.fun/bounty/sokoban-solver-01-run-20261121).

A level is a hallway with one to four rooms off it, and a box pushed out of
a room is lost — so each room is solved on its own, push-optimally, and the
rooms are joined by the player's walk along the hallway. Each room is solved
by a breadth-first search over pushes: a state is the boxes plus the player,
a step is one push, and states that differ only in where the player stands
inside one reachable region count once. The first solved state the search
meets is push-optimal.

## Layout

- `main.ts` — the whole solver: level parsing, room finding, the push
  search, and the driver that reads `/input/<id>/level.txt` and writes
  `/output/<id>/solution.txt`.
