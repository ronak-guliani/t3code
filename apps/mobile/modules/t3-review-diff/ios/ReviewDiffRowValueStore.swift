struct ReviewDiffRowValueStore<Value: Equatable> {
  private(set) var valuesByRowId: [String: Value] = [:]

  mutating func replace(with valuesByRowId: [String: Value]) {
    self.valuesByRowId = valuesByRowId
  }

  mutating func merge(_ patch: [String: Value]) -> Set<String> {
    var changedRowIds: Set<String> = []

    for (rowId, value) in patch where valuesByRowId[rowId] != value {
      valuesByRowId[rowId] = value
      changedRowIds.insert(rowId)
    }

    return changedRowIds
  }
}
