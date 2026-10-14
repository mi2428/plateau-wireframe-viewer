<?xml version="1.0" encoding="UTF-8"?>
<!-- Entirely synthetic CityGML 2.0 / iUR shape, reference, placement and LOD check. -->
<core:CityModel xml:base="./" xmlns:core="http://www.opengis.net/citygml/2.0" xmlns:gml="http://www.opengis.net/gml"
  xmlns:bldg="http://www.opengis.net/citygml/building/2.0" xmlns:gen="http://www.opengis.net/citygml/generics/2.0"
  xmlns:veg="http://www.opengis.net/citygml/vegetation/2.0" xmlns:dem="http://www.opengis.net/citygml/relief/2.0"
  xmlns:uro="https://www.geospatial.jp/iur/uro/3.2" xmlns:xlink="http://www.w3.org/1999/xlink">
  <gml:boundedBy><gml:Envelope srsName="EPSG:6677" srsDimension="3"><gml:lowerCorner>0 0 0</gml:lowerCorner><gml:upperCorner>80 100 30</gml:upperCorner></gml:Envelope></gml:boundedBy>
  <core:cityObjectMember>
    <bldg:Building gml:id="lod-building">
      <bldg:lod0FootPrint><gml:MultiSurface srsName="EPSG:6677" srsDimension="2"><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>0 0 0 20 20 20 20 0 0 0</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod0FootPrint>
      <bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>0 0 20 0 20 20 20 20 20 20 0 20 0 0 20</gml:posList></gml:LinearRing></gml:exterior><gml:interior><gml:LinearRing><gml:posList>5 5 20 5 10 20 10 10 20 10 5 20 5 5 20</gml:posList></gml:LinearRing></gml:interior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface>
    </bldg:Building>
  </core:cityObjectMember>
  <core:cityObjectMember>
    <gen:GenericCityObject gml:id="mixed-primitives">
      <gen:lod1Geometry><gml:MultiGeometry>
        <gml:geometryMember><gml:MultiPoint><gml:pointMember xlink:href="templates.gml#marker"/><gml:pointMembers><gml:Point><gml:pos>0 0 4</gml:pos></gml:Point><gml:Point><gml:pos>0 10 4</gml:pos></gml:Point></gml:pointMembers></gml:MultiPoint></gml:geometryMember>
        <gml:geometryMember><gml:CompositeCurve><gml:curveMember xlink:href="templates.gml#curve"/><gml:curveMember><gml:LineString><gml:pointProperty><gml:Point><gml:pos>0 10 4</gml:pos></gml:Point></gml:pointProperty><gml:pos>10 10 6</gml:pos></gml:LineString></gml:curveMember></gml:CompositeCurve></gml:geometryMember>
        <gml:geometryMember><gml:MultiCurve><gml:curveMember><gml:OrientableCurve orientation="-"><gml:baseCurve xlink:href="templates.gml#curve"/></gml:OrientableCurve></gml:curveMember><gml:curveMember><gml:Curve><gml:segments><gml:LineStringSegment><gml:posList>10 30 5 20 30 6</gml:posList></gml:LineStringSegment></gml:segments></gml:Curve></gml:curveMember></gml:MultiCurve></gml:geometryMember>
        <gml:geometryMember><gml:Polygon><gml:exterior><gml:Ring><gml:curveMember><gml:LineString><gml:posList>20 30 7 20 40 7 30 40 7</gml:posList></gml:LineString></gml:curveMember><gml:curveMember><gml:LineString><gml:posList>30 40 7 30 30 7 20 30 7</gml:posList></gml:LineString></gml:curveMember></gml:Ring></gml:exterior></gml:Polygon></gml:geometryMember>
        <gml:geometryMember><gml:MultiSolid><gml:solidMember><gml:Solid><gml:exterior><gml:CompositeSurface>
          <gml:surfaceMember><gml:Surface><gml:patches><gml:PolygonPatch><gml:exterior><gml:LinearRing><gml:posList>40 0 0 40 10 0 40 10 10 40 0 10 40 0 0</gml:posList></gml:LinearRing></gml:exterior></gml:PolygonPatch></gml:patches></gml:Surface></gml:surfaceMember>
          <gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>50 0 0 50 0 10 50 10 10 50 10 0 50 0 0</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember>
          <gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>40 0 0 40 0 10 50 0 10 50 0 0 40 0 0</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember>
          <gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>40 10 0 50 10 0 50 10 10 40 10 10 40 10 0</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember>
          <gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>40 0 0 50 0 0 50 10 0 40 10 0 40 0 0</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember>
          <gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>40 0 10 40 10 10 50 10 10 50 0 10 40 0 10</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember>
        </gml:CompositeSurface></gml:exterior></gml:Solid></gml:solidMember></gml:MultiSolid></gml:geometryMember>
        <gml:geometryMember><gml:TriangulatedSurface><gml:trianglePatches><gml:Triangle><gml:exterior><gml:LinearRing><gml:posList>40 30 0 40 40 0 50 40 3 40 30 0</gml:posList></gml:LinearRing></gml:exterior></gml:Triangle></gml:trianglePatches></gml:TriangulatedSurface></gml:geometryMember>
        <gml:geometryMember><gml:Tin><gml:trianglePatches><gml:Triangle><gml:exterior><gml:LinearRing><gml:posList>40 50 0 40 60 0 50 60 3 40 50 0</gml:posList></gml:LinearRing></gml:exterior></gml:Triangle></gml:trianglePatches></gml:Tin></gml:geometryMember>
      </gml:MultiGeometry></gen:lod1Geometry>
    </gen:GenericCityObject>
  </core:cityObjectMember>
  <core:cityObjectMember><veg:SolitaryVegetationObject gml:id="instance-a"><veg:lod2ImplicitRepresentation><core:ImplicitGeometry>
    <core:transformationMatrix>0 -1 0 10 1 0 0 20 0 0 2 3 0 0 0 1</core:transformationMatrix>
    <core:relativeGMLGeometry xlink:href="templates.gml#prototype"/>
    <core:referencePoint><gml:Point><gml:pos>50 60 10</gml:pos></gml:Point></core:referencePoint>
  </core:ImplicitGeometry></veg:lod2ImplicitRepresentation></veg:SolitaryVegetationObject></core:cityObjectMember>
  <core:cityObjectMember><veg:SolitaryVegetationObject gml:id="instance-b"><veg:lod2ImplicitRepresentation><core:ImplicitGeometry>
    <core:relativeGMLGeometry xlink:href="templates.gml#prototype"/>
    <core:referencePoint><gml:Point><gml:pos>60 80 10</gml:pos></gml:Point></core:referencePoint>
  </core:ImplicitGeometry></veg:lod2ImplicitRepresentation></veg:SolitaryVegetationObject></core:cityObjectMember>
  <core:cityObjectMember><dem:ReliefFeature gml:id="terrain"><dem:lod>1</dem:lod><dem:reliefComponent><dem:TINRelief gml:id="constrained-tin"><dem:lod>1</dem:lod><dem:tin><gml:Tin>
    <gml:trianglePatches/>
    <gml:breakLines><gml:LineStringSegment><gml:posList>60 0 1 80 20 1</gml:posList></gml:LineStringSegment></gml:breakLines>
    <gml:maxLength uom="m">40</gml:maxLength>
    <gml:controlPoint><gml:posList>60 0 1 60 20 2 80 20 1 80 0 2</gml:posList></gml:controlPoint>
  </gml:Tin></dem:tin></dem:TINRelief></dem:reliefComponent></dem:ReliefFeature></core:cityObjectMember>
  <core:cityObjectMember><gen:GenericCityObject gml:id="inline-cloud"><uro:pointCloud><uro:PointCloud><uro:lod>1</uro:lod><uro:points><gml:MultiPoint><gml:pointMembers>
    <gml:Point><gml:pos>70 70 5</gml:pos></gml:Point><gml:Point><gml:pos>75 75 8</gml:pos></gml:Point>
  </gml:pointMembers></gml:MultiPoint></uro:points></uro:PointCloud></uro:pointCloud></gen:GenericCityObject></core:cityObjectMember>
</core:CityModel>
